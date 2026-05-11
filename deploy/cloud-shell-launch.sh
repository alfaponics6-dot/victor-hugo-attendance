#!/usr/bin/env bash
#
# Provision an Always-Free Oracle Cloud VM for Victor Hugo.
# Designed to run in the Oracle Cloud Console > Cloud Shell (where `oci`
# is preauthenticated for your tenancy). Idempotent: re-running reuses
# any matching resources by name.
#
# Usage:
#   curl -sLO https://raw.githubusercontent.com/<owner>/<repo>/main/deploy/cloud-shell-launch.sh
#   chmod +x cloud-shell-launch.sh
#   DOMAIN=attendance.example.org SHAPE=A1 ./cloud-shell-launch.sh
#
# Env vars:
#   DOMAIN           required — your eventual public hostname (used in tags only)
#   SHAPE            A1 | MICRO (default A1).
#                      A1    → VM.Standard.A1.Flex, 2 OCPU + 12 GB ARM (recommended)
#                      MICRO → VM.Standard.E2.1.Micro, 1 OCPU + 1 GB x86
#   COMPARTMENT_OCID optional — defaults to your root tenancy
#   INSTANCE_NAME    optional — defaults to victor-hugo
#   SSH_KEY_PATH     optional — defaults to ~/.ssh/id_rsa.pub (generated if missing)

set -euo pipefail

: "${DOMAIN:?DOMAIN env var is required, e.g. attendance.example.org}"
SHAPE_KEY="${SHAPE:-A1}"
INSTANCE_NAME="${INSTANCE_NAME:-victor-hugo}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_rsa.pub}"

# ---------- 1. Compartment + tenancy ------------------------------------
TENANCY_OCID=$(oci iam compartment list --compartment-id-in-subtree true --all --raw-output --query "data[?\"name\"=='ROOT'].id | [0]" 2>/dev/null || true)
if [[ -z "$TENANCY_OCID" ]]; then
  TENANCY_OCID=$(oci os ns get --raw-output --query 'data' >/dev/null 2>&1 && grep -i tenancy ~/.oci/config | head -1 | awk -F= '{print $2}' | tr -d ' ' || true)
fi
COMPARTMENT_OCID="${COMPARTMENT_OCID:-$TENANCY_OCID}"
echo "==> Using compartment: $COMPARTMENT_OCID"

# ---------- 2. SSH key (generate if missing) ----------------------------
if [[ ! -f "$SSH_KEY_PATH" ]]; then
  echo "==> No SSH key at $SSH_KEY_PATH — generating an ED25519 keypair"
  ssh-keygen -t ed25519 -f "${SSH_KEY_PATH%.pub}" -N "" -C "victor-hugo-deploy"
fi
SSH_KEY_CONTENT=$(<"$SSH_KEY_PATH")

# ---------- 3. Shape + image lookup -------------------------------------
case "$SHAPE_KEY" in
  A1)
    SHAPE_NAME="VM.Standard.A1.Flex"
    OCPUS=2
    MEMORY_GB=12
    IMAGE_OS="Canonical Ubuntu"
    IMAGE_OS_VERSION="22.04"
    IMAGE_ARCH="aarch64"
    ;;
  MICRO)
    SHAPE_NAME="VM.Standard.E2.1.Micro"
    OCPUS=1
    MEMORY_GB=1
    IMAGE_OS="Canonical Ubuntu"
    IMAGE_OS_VERSION="22.04"
    IMAGE_ARCH="x86_64"
    ;;
  *)
    echo "Unknown SHAPE=$SHAPE_KEY (use A1 or MICRO)" >&2
    exit 1
    ;;
esac

echo "==> Shape: $SHAPE_NAME ($OCPUS OCPU, ${MEMORY_GB} GB)"

# ---------- 4. Availability domain (pick first) -------------------------
AD=$(oci iam availability-domain list --compartment-id "$COMPARTMENT_OCID" --raw-output --query 'data[0].name')
echo "==> Availability domain: $AD"

# Find the latest matching Ubuntu image for the shape's architecture.
# A1.Flex images carry "aarch64" in the display name; E2 images do not.
IMAGE_OCID=$(oci compute image list \
  --compartment-id "$COMPARTMENT_OCID" \
  --operating-system "$IMAGE_OS" \
  --operating-system-version "$IMAGE_OS_VERSION" \
  --shape "$SHAPE_NAME" \
  --sort-by TIMECREATED --sort-order DESC \
  --all --raw-output --query 'data[0].id')
echo "==> Image OCID: $IMAGE_OCID"

# ---------- 5. Network: VCN + subnet + IGW + route + security list -------
VCN_NAME="victor-hugo-vcn"
SUBNET_NAME="victor-hugo-subnet"
IGW_NAME="victor-hugo-igw"
RT_NAME="victor-hugo-rt"
SL_NAME="victor-hugo-sl"

VCN_OCID=$(oci network vcn list --compartment-id "$COMPARTMENT_OCID" --display-name "$VCN_NAME" --raw-output --query 'data[0].id' 2>/dev/null || echo "")
if [[ -z "$VCN_OCID" || "$VCN_OCID" == "null" ]]; then
  echo "==> Creating VCN $VCN_NAME"
  VCN_OCID=$(oci network vcn create \
    --compartment-id "$COMPARTMENT_OCID" \
    --cidr-block 10.0.0.0/16 \
    --display-name "$VCN_NAME" \
    --dns-label victorhugo \
    --wait-for-state AVAILABLE \
    --raw-output --query 'data.id')
fi
echo "    VCN: $VCN_OCID"

IGW_OCID=$(oci network internet-gateway list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" --display-name "$IGW_NAME" --raw-output --query 'data[0].id' 2>/dev/null || echo "")
if [[ -z "$IGW_OCID" || "$IGW_OCID" == "null" ]]; then
  echo "==> Creating Internet Gateway"
  IGW_OCID=$(oci network internet-gateway create \
    --compartment-id "$COMPARTMENT_OCID" \
    --vcn-id "$VCN_OCID" \
    --is-enabled true \
    --display-name "$IGW_NAME" \
    --wait-for-state AVAILABLE \
    --raw-output --query 'data.id')
fi
echo "    IGW: $IGW_OCID"

RT_OCID=$(oci network route-table list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" --display-name "$RT_NAME" --raw-output --query 'data[0].id' 2>/dev/null || echo "")
if [[ -z "$RT_OCID" || "$RT_OCID" == "null" ]]; then
  echo "==> Creating Route Table → IGW"
  RT_OCID=$(oci network route-table create \
    --compartment-id "$COMPARTMENT_OCID" \
    --vcn-id "$VCN_OCID" \
    --display-name "$RT_NAME" \
    --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW_OCID\"}]" \
    --wait-for-state AVAILABLE \
    --raw-output --query 'data.id')
fi
echo "    RT:  $RT_OCID"

SL_OCID=$(oci network security-list list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" --display-name "$SL_NAME" --raw-output --query 'data[0].id' 2>/dev/null || echo "")
if [[ -z "$SL_OCID" || "$SL_OCID" == "null" ]]; then
  echo "==> Creating Security List (22, 80, 443 inbound)"
  SL_OCID=$(oci network security-list create \
    --compartment-id "$COMPARTMENT_OCID" \
    --vcn-id "$VCN_OCID" \
    --display-name "$SL_NAME" \
    --egress-security-rules '[{"destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK","protocol":"all","isStateless":false}]' \
    --ingress-security-rules '[
       {"source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
       {"source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
       {"source":"0.0.0.0/0","sourceType":"CIDR_BLOCK","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}}}
     ]' \
    --wait-for-state AVAILABLE \
    --raw-output --query 'data.id')
fi
echo "    SL:  $SL_OCID"

SUBNET_OCID=$(oci network subnet list --compartment-id "$COMPARTMENT_OCID" --vcn-id "$VCN_OCID" --display-name "$SUBNET_NAME" --raw-output --query 'data[0].id' 2>/dev/null || echo "")
if [[ -z "$SUBNET_OCID" || "$SUBNET_OCID" == "null" ]]; then
  echo "==> Creating subnet"
  SUBNET_OCID=$(oci network subnet create \
    --compartment-id "$COMPARTMENT_OCID" \
    --vcn-id "$VCN_OCID" \
    --cidr-block 10.0.0.0/24 \
    --display-name "$SUBNET_NAME" \
    --route-table-id "$RT_OCID" \
    --security-list-ids "[\"$SL_OCID\"]" \
    --dns-label vh \
    --wait-for-state AVAILABLE \
    --raw-output --query 'data.id')
fi
echo "    Subnet: $SUBNET_OCID"

# ---------- 6. Launch instance ------------------------------------------
echo "==> Launching $INSTANCE_NAME on $SHAPE_NAME (this takes ~2 min)"

SHAPE_CFG_ARG=""
if [[ "$SHAPE_NAME" == "VM.Standard.A1.Flex" ]]; then
  SHAPE_CFG_ARG="--shape-config {\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}"
fi

# Note the `--` so the JSON shape-config doesn't get re-tokenised.
INSTANCE_OCID=$(eval oci compute instance launch \
  --compartment-id "$COMPARTMENT_OCID" \
  --availability-domain "$AD" \
  --shape "$SHAPE_NAME" \
  $SHAPE_CFG_ARG \
  --image-id "$IMAGE_OCID" \
  --subnet-id "$SUBNET_OCID" \
  --display-name "$INSTANCE_NAME" \
  --assign-public-ip true \
  --hostname-label vh \
  --metadata "{\"ssh_authorized_keys\":\"$SSH_KEY_CONTENT\"}" \
  --freeform-tags "{\"app\":\"victor-hugo\",\"domain\":\"$DOMAIN\"}" \
  --wait-for-state RUNNING \
  --raw-output --query 'data.id')

PUBLIC_IP=$(oci compute instance list-vnics --instance-id "$INSTANCE_OCID" --raw-output --query 'data[0]."public-ip"')

echo
echo "============================================================"
echo " Instance ready"
echo "============================================================"
echo " Public IP : $PUBLIC_IP"
echo " SSH       : ssh ubuntu@$PUBLIC_IP"
echo
echo " Next: point your DNS A record for $DOMAIN at $PUBLIC_IP,"
echo " then SSH in and run:"
echo
echo "   sudo apt-get update && sudo apt-get install -y git"
echo "   sudo mkdir -p /opt && sudo chown ubuntu /opt"
echo "   cd /opt && git clone https://github.com/<owner>/<repo>.git victorhugo"
echo "   cd victorhugo"
echo "   cp server/.env.production.example server/.env"
echo "   nano server/.env   # fill in CORS_ORIGINS, JWT_SECRET, LEADER_ACCESS_CODE"
echo "   chmod 600 server/.env"
echo "   DOMAIN=$DOMAIN ADMIN_EMAIL=you@example.org sudo -E ./deploy/bootstrap.sh"
echo "============================================================"
