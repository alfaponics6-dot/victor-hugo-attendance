#!/usr/bin/env python3
"""
End-to-end deploy of Victor Hugo to Oracle Cloud (Always Free).

Uses the OCI Python SDK directly — no shelling out to the `oci` CLI. This
avoids the entire class of "Windows argv mangles my JSON parameters"
problems we hit with the PowerShell version.

Authentication:
  Reads ~/.oci/config. Supports both:
    - api-key auth (regular `oci setup config`)
    - session-token auth (`oci session authenticate`)

What it does:
  1. Resolve auth + region + tenancy from ~/.oci/config
  2. Pick first availability domain in the region
  3. Look up the latest Canonical Ubuntu 22.04 image for the chosen shape
  4. Provision (idempotent — matches by display name):
       - VCN 10.0.0.0/16
       - Internet Gateway
       - Route Table 0.0.0.0/0 -> IGW
       - Security List (ingress 22, 80, 443; egress all)
       - Subnet 10.0.0.0/24
  5. Launch the VM with the user's SSH public key embedded
  6. Wait for SSH to open on :22
  7. SSH in, install git, clone the repo, write server/.env with freshly
     generated JWT_SECRET + LEADER_ACCESS_CODE, add 2 GB swap (needed for
     the Vite build on MICRO), run deploy/bootstrap.sh

Usage:
    python deploy_victor_hugo.py \\
        --domain forestryescenary.com \\
        --admin-email cchery@earth.ac.cr \\
        --shape MICRO

Or for ARM A1 (more headroom):
    python deploy_victor_hugo.py --domain ... --admin-email ... --shape A1

To target an existing VM (skip provisioning):
    python deploy_victor_hugo.py --domain ... --admin-email ... \\
        --skip-provision --existing-ip 1.2.3.4
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable, Optional

import oci
from oci.core.models import (
    CreateInternetGatewayDetails,
    CreateRouteTableDetails,
    CreateSecurityListDetails,
    CreateSubnetDetails,
    CreateVcnDetails,
    CreateVnicDetails,
    EgressSecurityRule,
    IngressSecurityRule,
    InstanceSourceViaImageDetails,
    LaunchInstanceDetails,
    PortRange,
    RouteRule,
    TcpOptions,
)

# ──────────────────────────────────────────────────────────────────────
# Output helpers — match the PowerShell version's idiom so the user gets
# familiar progress output.
# ──────────────────────────────────────────────────────────────────────
def section(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def detail(msg: str) -> None:
    print(f"    {msg}", flush=True)


def ok(msg: str) -> None:
    print(f"    [OK] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"    [WARN] {msg}", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


# ──────────────────────────────────────────────────────────────────────
# Auth — handles both api-key and session-token configs.
# ──────────────────────────────────────────────────────────────────────
def load_oci_clients() -> tuple[oci.identity.IdentityClient,
                                 oci.core.VirtualNetworkClient,
                                 oci.core.ComputeClient,
                                 dict]:
    section("Resolving OCI auth")
    try:
        config = oci.config.from_file()
    except Exception as e:
        die(
            "Could not read ~/.oci/config. Run `oci session authenticate` "
            f"(easy, browser-based) or `oci setup config`. Underlying error: {e}"
        )

    if "security_token_file" in config:
        # Session-token auth — signer needs the token text + the private key.
        token_path = config["security_token_file"]
        try:
            with open(token_path, "r") as f:
                token = f.read().strip()
        except OSError as e:
            die(f"Could not read security_token_file {token_path}: {e}")

        if not token:
            die("Security token file is empty. Run `oci session authenticate` to refresh.")

        try:
            private_key = oci.signer.load_private_key_from_file(config["key_file"])
        except Exception as e:
            die(f"Could not load private key {config['key_file']}: {e}")

        signer = oci.auth.signers.SecurityTokenSigner(token, private_key)
        detail("Using session-token auth (security_token)")
    else:
        signer = oci.signer.Signer(
            tenancy=config["tenancy"],
            user=config["user"],
            fingerprint=config["fingerprint"],
            private_key_file_location=config["key_file"],
        )
        detail("Using api-key auth")

    # Cheap probe to verify the credentials work.
    identity = oci.identity.IdentityClient(config, signer=signer)
    try:
        # list_regions is a tenancy-wide read that any auth principal can do.
        identity.list_regions()
        ok("OCI authenticated")
    except oci.exceptions.ServiceError as e:
        if e.status == 401:
            die(
                "OCI auth rejected (HTTP 401). If you used `oci session "
                "authenticate`, the session has likely expired (tokens last "
                "~1 hour). Re-run that command and try again."
            )
        die(f"OCI auth probe failed: {e}")

    vnet = oci.core.VirtualNetworkClient(config, signer=signer)
    compute = oci.core.ComputeClient(config, signer=signer)
    detail(f"Region: {config['region']}")
    detail(f"Tenancy: {config['tenancy']}")
    return identity, vnet, compute, config


# ──────────────────────────────────────────────────────────────────────
# Idempotent network resource helpers.
# Each "find or create" lookup matches by display name within the
# compartment + VCN scope.
# ──────────────────────────────────────────────────────────────────────
def find_by_name(items: Iterable, name: str):
    for item in items:
        if getattr(item, "display_name", None) == name:
            return item
    return None


def wait_for_state(client, get_fn, target_state: str, timeout_s: int = 300) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        resp = get_fn()
        state = getattr(resp.data, "lifecycle_state", None)
        if state == target_state:
            return
        time.sleep(2)
    raise TimeoutError(f"Resource did not reach {target_state} within {timeout_s}s")


def ensure_vcn(vnet, compartment_id):
    vcns = vnet.list_vcns(compartment_id=compartment_id).data
    vcn = find_by_name(vcns, "victor-hugo-vcn")
    if vcn:
        return vcn
    detail("Creating VCN victor-hugo-vcn (10.0.0.0/16)")
    resp = vnet.create_vcn(CreateVcnDetails(
        cidr_block="10.0.0.0/16",
        compartment_id=compartment_id,
        display_name="victor-hugo-vcn",
        dns_label="victorhugo",
    ))
    wait_for_state(vnet, lambda: vnet.get_vcn(resp.data.id), "AVAILABLE")
    return vnet.get_vcn(resp.data.id).data


def ensure_internet_gateway(vnet, compartment_id, vcn_id):
    igws = vnet.list_internet_gateways(compartment_id=compartment_id, vcn_id=vcn_id).data
    igw = find_by_name(igws, "victor-hugo-igw")
    if igw:
        return igw
    detail("Creating Internet Gateway")
    resp = vnet.create_internet_gateway(CreateInternetGatewayDetails(
        compartment_id=compartment_id,
        vcn_id=vcn_id,
        display_name="victor-hugo-igw",
        is_enabled=True,
    ))
    wait_for_state(vnet, lambda: vnet.get_internet_gateway(resp.data.id), "AVAILABLE")
    return vnet.get_internet_gateway(resp.data.id).data


def ensure_route_table(vnet, compartment_id, vcn_id, igw_id):
    rts = vnet.list_route_tables(compartment_id=compartment_id, vcn_id=vcn_id).data
    rt = find_by_name(rts, "victor-hugo-rt")
    if rt:
        # If it exists with no rules (from an earlier broken run), update it.
        if not rt.route_rules:
            detail("Existing RT has no rules — updating to add 0.0.0.0/0 → IGW")
            rules = [RouteRule(
                destination="0.0.0.0/0",
                destination_type="CIDR_BLOCK",
                network_entity_id=igw_id,
            )]
            vnet.update_route_table(rt.id, oci.core.models.UpdateRouteTableDetails(
                route_rules=rules,
            ))
            wait_for_state(vnet, lambda: vnet.get_route_table(rt.id), "AVAILABLE")
            rt = vnet.get_route_table(rt.id).data
        return rt
    detail("Creating Route Table → IGW")
    rules = [RouteRule(
        destination="0.0.0.0/0",
        destination_type="CIDR_BLOCK",
        network_entity_id=igw_id,
    )]
    resp = vnet.create_route_table(CreateRouteTableDetails(
        compartment_id=compartment_id,
        vcn_id=vcn_id,
        display_name="victor-hugo-rt",
        route_rules=rules,
    ))
    wait_for_state(vnet, lambda: vnet.get_route_table(resp.data.id), "AVAILABLE")
    return vnet.get_route_table(resp.data.id).data


def ensure_security_list(vnet, compartment_id, vcn_id):
    sls = vnet.list_security_lists(compartment_id=compartment_id, vcn_id=vcn_id).data
    sl = find_by_name(sls, "victor-hugo-sl")

    def make_ingress(port: int) -> IngressSecurityRule:
        return IngressSecurityRule(
            source="0.0.0.0/0",
            source_type="CIDR_BLOCK",
            protocol="6",  # TCP
            is_stateless=False,
            tcp_options=TcpOptions(destination_port_range=PortRange(min=port, max=port)),
        )

    ingress_rules = [make_ingress(22), make_ingress(80), make_ingress(443)]
    egress_rules = [EgressSecurityRule(
        destination="0.0.0.0/0",
        destination_type="CIDR_BLOCK",
        protocol="all",
        is_stateless=False,
    )]

    if sl:
        # Patch if rules are missing (broken from earlier run).
        if not sl.ingress_security_rules:
            detail("Existing SL has no rules — updating to open 22/80/443")
            vnet.update_security_list(sl.id, oci.core.models.UpdateSecurityListDetails(
                ingress_security_rules=ingress_rules,
                egress_security_rules=egress_rules,
            ))
            wait_for_state(vnet, lambda: vnet.get_security_list(sl.id), "AVAILABLE")
            sl = vnet.get_security_list(sl.id).data
        return sl

    detail("Creating Security List (ingress 22/80/443)")
    resp = vnet.create_security_list(CreateSecurityListDetails(
        compartment_id=compartment_id,
        vcn_id=vcn_id,
        display_name="victor-hugo-sl",
        ingress_security_rules=ingress_rules,
        egress_security_rules=egress_rules,
    ))
    wait_for_state(vnet, lambda: vnet.get_security_list(resp.data.id), "AVAILABLE")
    return vnet.get_security_list(resp.data.id).data


def ensure_subnet(vnet, compartment_id, vcn_id, rt_id, sl_id):
    subnets = vnet.list_subnets(compartment_id=compartment_id, vcn_id=vcn_id).data
    subnet = find_by_name(subnets, "victor-hugo-subnet")
    if subnet:
        return subnet
    detail("Creating subnet 10.0.0.0/24")
    resp = vnet.create_subnet(CreateSubnetDetails(
        compartment_id=compartment_id,
        vcn_id=vcn_id,
        cidr_block="10.0.0.0/24",
        display_name="victor-hugo-subnet",
        route_table_id=rt_id,
        security_list_ids=[sl_id],
        dns_label="vh",
    ))
    wait_for_state(vnet, lambda: vnet.get_subnet(resp.data.id), "AVAILABLE")
    return vnet.get_subnet(resp.data.id).data


# ──────────────────────────────────────────────────────────────────────
# Image lookup + VM launch
# ──────────────────────────────────────────────────────────────────────
SHAPE_TABLE = {
    "MICRO": {"name": "VM.Standard.E2.1.Micro", "ocpus": 1, "mem_gb": 1},
    "A1":    {"name": "VM.Standard.A1.Flex",    "ocpus": 2, "mem_gb": 12},
}


def latest_ubuntu_image(compute, compartment_id, shape_name: str) -> str:
    resp = compute.list_images(
        compartment_id=compartment_id,
        operating_system="Canonical Ubuntu",
        operating_system_version="22.04",
        shape=shape_name,
        sort_by="TIMECREATED",
        sort_order="DESC",
    )
    if not resp.data:
        die(f"No Ubuntu 22.04 image found for shape {shape_name}. Wrong region for this shape?")
    return resp.data[0].id


def find_existing_instance(compute, compartment_id, ad, name):
    resp = compute.list_instances(
        compartment_id=compartment_id,
        availability_domain=ad,
        display_name=name,
    )
    for inst in resp.data:
        if inst.lifecycle_state in ("RUNNING", "STARTING", "PROVISIONING"):
            return inst
    return None


def _is_capacity_error(e: "oci.exceptions.ServiceError") -> bool:
    """Oracle reports out-of-capacity in two ways depending on which limit:
       - 500 InternalError "Out of host capacity" (Always-Free A1 is famous for this)
       - 400 LimitExceeded (tenancy quota exhausted; different error, see _is_quota_error)"""
    msg = (e.message or "").lower()
    return e.status == 500 and ("out of host capacity" in msg or "out of capacity" in msg)


def _is_quota_error(e: "oci.exceptions.ServiceError") -> bool:
    return e.status == 400 and e.code == "LimitExceeded"


def _list_fault_domains(identity, compartment_id, ad):
    resp = identity.list_fault_domains(compartment_id=compartment_id, availability_domain=ad)
    return [fd.name for fd in resp.data] or [None]


def launch_instance(identity, compute, vnet, compartment_id, ad, shape, image_id, subnet_id,
                    ssh_pub_key, instance_name, domain,
                    capacity_wait_minutes: int = 60):
    existing = find_existing_instance(compute, compartment_id, ad, instance_name)
    if existing:
        detail(f"Reusing existing instance {existing.id} ({existing.lifecycle_state})")
        instance = existing
    else:
        # Each AD has up to 3 fault domains, each with a separate capacity pool.
        # Cycling through them on "Out of host capacity" gets us a slot way more
        # reliably than retrying the API-default. We then wait + retry the loop
        # for up to capacity_wait_minutes for Always-Free A1, which is famously
        # capacity-starved in some regions.
        fault_domains = _list_fault_domains(identity, compartment_id, ad)
        detail(f"Fault domains in {ad}: {', '.join(str(fd) for fd in fault_domains)}")

        base_details = LaunchInstanceDetails(
            compartment_id=compartment_id,
            availability_domain=ad,
            shape=shape["name"],
            image_id=image_id,
            display_name=instance_name,
            metadata={"ssh_authorized_keys": ssh_pub_key},
            freeform_tags={"app": "victor-hugo", "domain": domain},
            source_details=InstanceSourceViaImageDetails(
                source_type="image",
                image_id=image_id,
            ),
            create_vnic_details=CreateVnicDetails(
                subnet_id=subnet_id,
                assign_public_ip=True,
                hostname_label="vh",
            ),
        )
        if shape["name"] == "VM.Standard.A1.Flex":
            base_details.shape_config = oci.core.models.LaunchInstanceShapeConfigDetails(
                ocpus=shape["ocpus"],
                memory_in_gbs=shape["mem_gb"],
            )

        instance = None
        deadline = time.time() + capacity_wait_minutes * 60
        attempt = 0
        while instance is None and time.time() < deadline:
            attempt += 1
            for fd in fault_domains:
                if fd:
                    base_details.fault_domain = fd
                fd_label = fd if fd else "(api default)"
                try:
                    detail(f"Attempt {attempt}: launching in fault domain {fd_label}")
                    resp = compute.launch_instance(base_details)
                    instance = resp.data
                    ok(f"Launched in {fd_label} — instance id {instance.id}")
                    break
                except oci.exceptions.ServiceError as e:
                    if _is_capacity_error(e):
                        warn(f"{fd_label}: out of host capacity, trying next FD")
                        continue
                    if _is_quota_error(e):
                        die(
                            "Tenancy quota exhausted (LimitExceeded). Either "
                            "terminate an existing instance of this shape, or "
                            "request a quota increase in the Oracle Console "
                            "(Governance > Limits, Quotas and Usage)."
                        )
                    raise
            else:
                # All FDs were exhausted on this attempt → wait and retry.
                remaining = int(deadline - time.time())
                if remaining <= 0:
                    break
                wait_s = min(60, remaining)
                warn(
                    f"All {len(fault_domains)} fault domains out of capacity. "
                    f"Sleeping {wait_s}s before next attempt (giving up at "
                    f"{capacity_wait_minutes} min)."
                )
                time.sleep(wait_s)

        if instance is None:
            die(
                "Could not obtain capacity for "
                f"{shape['name']} in {ad} within {capacity_wait_minutes} minutes. "
                "Always-Free A1 capacity in some regions (us-sanjose-1, us-phoenix-1, "
                "ap-tokyo-1) can be saturated for hours-to-days. Options: "
                "(1) re-run later — script will reuse network resources. "
                "(2) switch region via `oci session authenticate` (e.g. eu-frankfurt-1, "
                "us-ashburn-1 often have headroom). "
                "(3) request a paid quota bump in the console (free A1 is best-effort)."
            )

        # Wait for RUNNING.
        wait_deadline = time.time() + 300
        while time.time() < wait_deadline:
            inst = compute.get_instance(instance.id).data
            if inst.lifecycle_state == "RUNNING":
                instance = inst
                break
            time.sleep(5)
        else:
            die("Instance did not reach RUNNING within 5 minutes after launch.")

    # Get the public IP.
    vnics = compute.list_vnic_attachments(compartment_id=compartment_id, instance_id=instance.id).data
    if not vnics:
        die("Instance has no VNIC attached")
    vnic = vnet.get_vnic(vnics[0].vnic_id).data
    return instance, vnic.public_ip


# ──────────────────────────────────────────────────────────────────────
# Local helpers
# ──────────────────────────────────────────────────────────────────────
def ensure_ssh_key() -> tuple[Path, str]:
    section("SSH key")
    key_path = Path.home() / ".ssh" / "id_ed25519"
    if not key_path.exists():
        key_path.parent.mkdir(parents=True, exist_ok=True)
        detail(f"Generating ed25519 keypair at {key_path}")
        subprocess.run([
            "ssh-keygen", "-t", "ed25519",
            "-f", str(key_path),
            "-N", "",
            "-C", "victor-hugo-deploy",
        ], check=True)
    pub = (key_path.with_suffix(".pub")).read_text().strip()
    ok(f"Public key ready at {key_path}.pub")
    return key_path, pub


def wait_for_ssh(ip: str, timeout_s: int = 300) -> None:
    section(f"Waiting for SSH on {ip}")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with socket.create_connection((ip, 22), timeout=4):
                ok("SSH port open")
                # Give cloud-init another beat to inject our key.
                time.sleep(8)
                return
        except OSError:
            time.sleep(5)
            detail("... still booting")
    die(f"SSH on {ip} never came up after {timeout_s}s")


def new_secret_b64(num_bytes: int = 48) -> str:
    return base64.b64encode(secrets.token_bytes(num_bytes)).decode("ascii")


def pick_access_code() -> str:
    raw = base64.b64encode(secrets.token_bytes(12)).decode("ascii")
    clean = raw.replace("+", "").replace("/", "").replace("=", "")
    return clean[:12]


# ──────────────────────────────────────────────────────────────────────
# Remote bootstrap via SSH
# ──────────────────────────────────────────────────────────────────────
REMOTE_SCRIPT = r"""
set -euo pipefail

echo '==> Updating apt + installing git'
sudo apt-get update -qq
sudo apt-get install -y -qq git ca-certificates

echo "==> Cloning ${REPO_URL}"
sudo mkdir -p /opt
sudo chown ubuntu:ubuntu /opt
if [ -d /opt/victorhugo/.git ]; then
  cd /opt/victorhugo && git pull --ff-only
else
  git clone "${REPO_URL}" /opt/victorhugo
fi
cd /opt/victorhugo

echo '==> Writing /opt/victorhugo/server/.env'
cat > server/.env <<ENVEOF
PORT=3000
NODE_ENV=production
CORS_ORIGINS=https://${DOMAIN}
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h
LEADER_ACCESS_CODE=${LEADER_ACCESS_CODE}
TRUST_PROXY=true
ENVEOF
chmod 600 server/.env

echo '==> Adding 2 GB swap (MICRO can OOM during Vite build without it; idempotent)'
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab >/dev/null
fi
free -h | head -2

echo '==> Running deploy/bootstrap.sh (Node, build, nginx, certbot, systemd, cron)'
chmod +x deploy/bootstrap.sh
sudo -E DOMAIN="${DOMAIN}" ADMIN_EMAIL="${ADMIN_EMAIL}" JWT_SECRET="${JWT_SECRET}" LEADER_ACCESS_CODE="${LEADER_ACCESS_CODE}" ./deploy/bootstrap.sh

echo
echo '==> Smoke check'
curl -fsS "https://${DOMAIN}/api/health" || echo '   (health not reachable yet; certbot may still be settling)'
echo
echo "Deploy finished. SPA: https://${DOMAIN}"
"""


def run_bootstrap_remote(ip: str, key_path: Path, env: dict) -> None:
    section(f"Bootstrapping app on {ip}")
    # Pass the secret env vars through SSH's environment forwarding. We
    # use a wrapper that exports them first, then runs the script via stdin.
    # `sudo -E` propagates them to bootstrap.sh.
    export_lines = "\n".join(
        f"export {k}={shell_quote(v)}" for k, v in env.items()
    )
    full_script = export_lines + "\n" + REMOTE_SCRIPT

    ssh_cmd = [
        "ssh",
        "-i", str(key_path),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UserKnownHostsFile=" + str(Path.home() / ".ssh" / "known_hosts"),
        f"ubuntu@{ip}",
        "bash -s",
    ]
    detail("Streaming remote bootstrap output...")
    result = subprocess.run(
        ssh_cmd,
        input=full_script,
        text=True,
    )
    if result.returncode != 0:
        die(f"Remote bootstrap exited with code {result.returncode}")


def shell_quote(s: str) -> str:
    """POSIX-safe single-quote escape for env-var values."""
    return "'" + s.replace("'", "'\"'\"'") + "'"


# ──────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy Victor Hugo to Oracle Cloud Always Free.")
    parser.add_argument("--domain", required=True, help="Public hostname, e.g. attendance.example.org")
    parser.add_argument("--admin-email", required=True, help="Email for Let's Encrypt cert renewals")
    parser.add_argument("--shape", choices=["MICRO", "A1"], default="MICRO")
    parser.add_argument("--instance-name", default="victor-hugo")
    parser.add_argument(
        "--repo-url",
        default="https://github.com/alfaponics6-dot/victor-hugo-attendance.git",
        help="Public git URL the VM clones from",
    )
    parser.add_argument("--leader-access-code", default=None,
                        help="Shared password for leader-role logins. Auto-generated if omitted.")
    parser.add_argument("--skip-provision", action="store_true",
                        help="Skip VM/network creation. Requires --existing-ip.")
    parser.add_argument("--existing-ip", default=None,
                        help="Use with --skip-provision to deploy onto an existing VM.")
    parser.add_argument("--capacity-wait", type=int, default=60,
                        help="Minutes to keep retrying on 'Out of host capacity' (Always-Free A1 in "
                             "constrained regions can take hours). Default 60.")
    args = parser.parse_args()

    if args.skip_provision and not args.existing_ip:
        die("--skip-provision requires --existing-ip")

    # 1. Local SSH key.
    key_path, ssh_pub_key = ensure_ssh_key()

    # 2. OCI auth.
    identity, vnet, compute, config = load_oci_clients()
    compartment_id = os.environ.get("COMPARTMENT_OCID") or config["tenancy"]
    detail(f"Compartment: {compartment_id}")

    public_ip: Optional[str] = args.existing_ip

    if not args.skip_provision:
        # 3. AD + image.
        section("Resolving availability domain + image")
        ads = identity.list_availability_domains(compartment_id=compartment_id).data
        if not ads:
            die("No availability domains found in this compartment.")
        ad = ads[0].name
        detail(f"Availability domain: {ad}")

        shape = SHAPE_TABLE[args.shape]
        detail(f"Shape: {shape['name']} ({shape['ocpus']} OCPU, {shape['mem_gb']} GB)")

        image_id = latest_ubuntu_image(compute, compartment_id, shape["name"])
        detail(f"Image OCID: {image_id}")

        # 4. Network.
        section("Provisioning network")
        vcn = ensure_vcn(vnet, compartment_id)
        ok(f"VCN: {vcn.id}")
        igw = ensure_internet_gateway(vnet, compartment_id, vcn.id)
        ok(f"IGW: {igw.id}")
        rt = ensure_route_table(vnet, compartment_id, vcn.id, igw.id)
        ok(f"RT:  {rt.id}")
        sl = ensure_security_list(vnet, compartment_id, vcn.id)
        ok(f"SL:  {sl.id}")
        subnet = ensure_subnet(vnet, compartment_id, vcn.id, rt.id, sl.id)
        ok(f"Subnet: {subnet.id}")

        # 5. VM.
        section(f"Launching instance {args.instance_name}")
        instance, public_ip = launch_instance(
            identity, compute, vnet, compartment_id, ad, shape, image_id, subnet.id,
            ssh_pub_key, args.instance_name, args.domain,
            capacity_wait_minutes=args.capacity_wait,
        )
        ok(f"Instance: {instance.id}")
        ok(f"Public IP: {public_ip}")

    if not public_ip:
        die("No public IP — something went wrong before VM launch.")

    # 6. SSH.
    wait_for_ssh(public_ip)

    # 7. DNS pre-flight.
    section(f"DNS pre-flight for {args.domain}")
    try:
        resolved = socket.gethostbyname(args.domain)
        if resolved == public_ip:
            ok(f"{args.domain} resolves to {public_ip}")
        else:
            warn(f"{args.domain} resolves to {resolved}, not {public_ip}")
            warn("Update the A record at your DNS provider to point at the new IP.")
            warn("certbot will fail if DNS is not pointing at the VM when it runs.")
            input("Press Enter when DNS is set (or Ctrl+C to abort) > ")
    except socket.gaierror:
        warn(f"{args.domain} doesn't resolve yet.")
        warn(f"Add an A record: {args.domain} -> {public_ip}, wait ~5 min, then continue.")
        input("Press Enter when DNS is set (or Ctrl+C to abort) > ")

    # 8. Secrets.
    section("Generating fresh secrets")
    jwt_secret = new_secret_b64(48)
    leader_code = args.leader_access_code or pick_access_code()
    ok("JWT_SECRET generated")
    ok(f"LEADER_ACCESS_CODE: {leader_code}")

    # 9. Remote bootstrap.
    env = {
        "DOMAIN": args.domain,
        "ADMIN_EMAIL": args.admin_email,
        "JWT_SECRET": jwt_secret,
        "LEADER_ACCESS_CODE": leader_code,
        "REPO_URL": args.repo_url,
    }
    run_bootstrap_remote(public_ip, key_path, env)

    # 10. Done.
    print("\n" + "=" * 60)
    print(" DEPLOY COMPLETE")
    print("=" * 60)
    print(f" URL                : https://{args.domain}")
    print(f" Public IP          : {public_ip}")
    print(f" SSH                : ssh -i {key_path} ubuntu@{public_ip}")
    print(f" LEADER_ACCESS_CODE : {leader_code}   (share with leaders)")
    print(f" JWT_SECRET         : (set on VM in /opt/victorhugo/server/.env, chmod 600)")
    print("=" * 60)
    print()
    print(f"Open https://{args.domain} and verify the login screen.")
    print("If certbot is still settling, give it ~60 s and retry.")
    print(f"Logs: ssh -i {key_path} ubuntu@{public_ip} 'sudo journalctl -u victorhugo-api -n 200'")
    return 0


if __name__ == "__main__":
    sys.exit(main())
