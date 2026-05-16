"""
debug_profe_integration.py
==========================
Live integration tests for the profesor-attendance + coordinator
features deployed at https://forestryescenary.com.

These tests hit the REAL server. They use a clearly-fake date
(2099-01-15) for any save operations so they cannot pollute real
attendance records.

Run:
    python debug_profe_integration.py

Exit code:
    0 = all assertions passed
    1 = at least one assertion failed
    2 = setup failure (e.g. cannot reach the server)
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from typing import Any, Dict, List, Optional, Tuple

import requests


BASE_URL = "https://forestryescenary.com"
TIMEOUT = 30  # seconds

# Test accounts (per CLAUDE / user instructions)
SHARED_PROFE_PW = "EARTH2026"
LLUVIA_ID = 2      # admin, is_coordinator=0, canDeleteStudents=0
RONALD_ID = 16     # profesor, is_coordinator=1
SIMON_ID = 20      # profesor, is_coordinator=0

FAKE_DATE = "2099-01-15"     # save tests use this
REAL_TODAY = "2026-05-15"    # only used for read-only gate checks

# Collect "findings" notes that aren't test failures but suggest bugs
FINDINGS: List[str] = []


def add_finding(note: str) -> None:
    FINDINGS.append(note)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def login(session: requests.Session, leader_id: int, *, password: Optional[str] = None,
          access_code: Optional[str] = None) -> requests.Response:
    """Hit /api/auth/login and return the raw response.

    Cookie is automatically captured in `session` on success.
    """
    body: Dict[str, Any] = {"leaderId": leader_id}
    if password is not None:
        body["password"] = password
    if access_code is not None:
        body["accessCode"] = access_code
    return session.post(f"{BASE_URL}/api/auth/login", json=body, timeout=TIMEOUT)


def verify(session: requests.Session) -> requests.Response:
    return session.get(f"{BASE_URL}/api/auth/verify", timeout=TIMEOUT)


def safe_json(resp: requests.Response) -> Any:
    try:
        return resp.json()
    except Exception:
        return {"_non_json_body": resp.text[:500]}


def fmt_resp(resp: requests.Response) -> str:
    return f"HTTP {resp.status_code} body={json.dumps(safe_json(resp), default=str)[:500]}"


def get_project_students(session: requests.Session, project_id: int) -> List[Dict[str, Any]]:
    r = session.get(f"{BASE_URL}/api/projects/{project_id}/students", timeout=TIMEOUT)
    r.raise_for_status()
    data = r.json()
    # Endpoint may return a plain list or {students:[...]}, normalise.
    if isinstance(data, dict) and "students" in data:
        return data["students"]
    return data


def find_regular_leader_id(session: requests.Session) -> Optional[int]:
    """Use the public /api/auth/leaders list to find any leader (role='leader')."""
    r = session.get(f"{BASE_URL}/api/auth/leaders", timeout=TIMEOUT)
    if r.status_code != 200:
        return None
    for entry in r.json():
        if entry.get("role") == "leader":
            return entry.get("id")
    return None


def find_other_project_student_id(session: requests.Session,
                                  exclude_project_id: int) -> Optional[Tuple[int, int]]:
    """Find a (student_id, project_id) where project_id != exclude_project_id.
    Used for the cross-tenant test.
    """
    r = session.get(f"{BASE_URL}/api/projects", timeout=TIMEOUT)
    if r.status_code != 200:
        return None
    projects = r.json()
    if isinstance(projects, dict) and "projects" in projects:
        projects = projects["projects"]
    for p in projects:
        pid = p.get("id") or p.get("project_id")
        if not pid or pid == exclude_project_id:
            continue
        try:
            students = get_project_students(session, pid)
        except Exception:
            continue
        if students:
            return (students[0]["id"], pid)
    return None


# ---------------------------------------------------------------------------
# Pre-flight: confirm the server is reachable, otherwise abort with exit 2
# ---------------------------------------------------------------------------

def preflight() -> None:
    try:
        r = requests.get(f"{BASE_URL}/api/health", timeout=TIMEOUT)
        if r.status_code >= 500:
            print(f"[PREFLIGHT] /api/health returned {r.status_code}: {r.text[:200]}")
            sys.exit(2)
    except requests.RequestException as exc:
        print(f"[PREFLIGHT] Could not reach {BASE_URL}: {exc}")
        sys.exit(2)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

class LoginShapeTests(unittest.TestCase):
    """1. Login + profile shape."""

    def test_ronald_login_profile(self) -> None:
        s = requests.Session()
        r = login(s, RONALD_ID, password=SHARED_PROFE_PW)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        body = r.json()
        self.assertTrue(body.get("success"), msg=fmt_resp(r))
        leader = body["leader"]
        self.assertEqual(leader["id"], RONALD_ID)
        self.assertEqual(leader["role"], "profesor", msg=fmt_resp(r))
        self.assertTrue(leader.get("isCoordinator") is True,
                        msg=f"Ronald should be coordinator, got {leader.get('isCoordinator')!r}")
        # Ronald is a profesor — coordinator flag flip shouldn't have changed
        # the default can_delete_students (1).
        self.assertTrue(leader.get("canDeleteStudents") is True,
                        msg=f"Ronald canDeleteStudents expected True, got {leader.get('canDeleteStudents')!r}")

    def test_simon_login_profile(self) -> None:
        s = requests.Session()
        r = login(s, SIMON_ID, password=SHARED_PROFE_PW)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        leader = r.json()["leader"]
        self.assertEqual(leader["id"], SIMON_ID)
        self.assertEqual(leader["role"], "profesor")
        self.assertFalse(leader["isCoordinator"],
                         msg=f"Simon should NOT be coordinator, got {leader['isCoordinator']!r}")

    def test_lluvia_login_profile(self) -> None:
        s = requests.Session()
        r = login(s, LLUVIA_ID, password=SHARED_PROFE_PW)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        leader = r.json()["leader"]
        self.assertEqual(leader["id"], LLUVIA_ID)
        self.assertEqual(leader["role"], "admin", msg=fmt_resp(r))
        # We deliberately set Lluvia.can_delete_students = 0 earlier.
        self.assertFalse(leader["canDeleteStudents"],
                         msg=f"Lluvia canDeleteStudents expected False, got {leader['canDeleteStudents']!r}")
        # Admin should NOT be coordinator unless flipped.
        self.assertFalse(leader["isCoordinator"],
                         msg=f"Lluvia isCoordinator expected False, got {leader['isCoordinator']!r}")


class VerifyShapeTests(unittest.TestCase):
    """2. /auth/verify returns the same role+flag shape."""

    def _verify_user(self, leader_id: int, expected_role: str,
                     expected_is_coord: bool, expected_can_delete: bool) -> None:
        s = requests.Session()
        r = login(s, leader_id, password=SHARED_PROFE_PW)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        v = verify(s)
        self.assertEqual(v.status_code, 200, msg=fmt_resp(v))
        body = v.json()
        self.assertTrue(body.get("valid"), msg=fmt_resp(v))
        user = body["user"]
        self.assertEqual(user["id"], leader_id)
        self.assertEqual(user["role"], expected_role,
                         msg=f"verify role mismatch for {leader_id}: got {user['role']!r}")
        self.assertEqual(bool(user.get("isCoordinator")), expected_is_coord,
                         msg=f"verify isCoordinator mismatch for {leader_id}: got {user.get('isCoordinator')!r}")
        self.assertEqual(bool(user.get("canDeleteStudents")), expected_can_delete,
                         msg=f"verify canDeleteStudents mismatch for {leader_id}: got {user.get('canDeleteStudents')!r}")

    def test_verify_ronald(self) -> None:
        self._verify_user(RONALD_ID, "profesor", True, True)

    def test_verify_simon(self) -> None:
        self._verify_user(SIMON_ID, "profesor", False, True)

    def test_verify_lluvia(self) -> None:
        self._verify_user(LLUVIA_ID, "admin", False, False)


class CoordinatorGateTests(unittest.TestCase):
    """3. Coordinator gate on /compliance/:date.

    We deliberately use REAL_TODAY here because it's a read-only operation.
    """

    URL = f"{BASE_URL}/api/profesor-attendance/compliance/{REAL_TODAY}"

    def test_ronald_coordinator_allowed(self) -> None:
        s = requests.Session()
        login(s, RONALD_ID, password=SHARED_PROFE_PW)
        r = s.get(self.URL, timeout=TIMEOUT)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        body = r.json()
        self.assertIsInstance(body, list, msg=fmt_resp(r))

    def test_simon_profe_blocked(self) -> None:
        s = requests.Session()
        login(s, SIMON_ID, password=SHARED_PROFE_PW)
        r = s.get(self.URL, timeout=TIMEOUT)
        self.assertEqual(r.status_code, 403, msg=fmt_resp(r))

    def test_lluvia_admin_blocked(self) -> None:
        # Admin is NOT a coordinator by default — must get 403.
        s = requests.Session()
        login(s, LLUVIA_ID, password=SHARED_PROFE_PW)
        r = s.get(self.URL, timeout=TIMEOUT)
        self.assertEqual(r.status_code, 403,
                         msg=f"Admin should be 403 on coordinator gate; got {fmt_resp(r)}")

    def test_unauthenticated_blocked(self) -> None:
        r = requests.get(self.URL, timeout=TIMEOUT)
        self.assertEqual(r.status_code, 401, msg=fmt_resp(r))


class ProfesorEndpointTests(unittest.TestCase):
    """4. Profesor endpoints (read + bulk write).

    Uses FAKE_DATE for any writes.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.s = requests.Session()
        r = login(cls.s, SIMON_ID, password=SHARED_PROFE_PW)
        if r.status_code != 200:
            raise unittest.SkipTest(f"Could not login as Simon: {fmt_resp(r)}")
        cls.students = get_project_students(cls.s, 1)
        if not cls.students:
            raise unittest.SkipTest("Project 1 has no students — cannot exercise bulk save.")

    def test_simon_project_date_read(self) -> None:
        url = f"{BASE_URL}/api/profesor-attendance/project/1/date/{REAL_TODAY}"
        r = self.s.get(url, timeout=TIMEOUT)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        body = r.json()
        self.assertIsInstance(body, list, msg=f"expected list, got {type(body).__name__}: {body!r}")

    def test_simon_bulk_save_and_roundtrip(self) -> None:
        # Just take the first student and set them to present.
        first = self.students[0]
        sid = first["id"]
        payload = {
            "projectId": 1,
            "date": FAKE_DATE,
            "passType": "end",
            "entries": [{"student_id": sid, "status": "present"}],
        }
        r = self.s.post(f"{BASE_URL}/api/profesor-attendance/bulk",
                        json=payload, timeout=TIMEOUT)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        body = r.json()
        self.assertTrue(body.get("success"), msg=fmt_resp(r))

        # Round-trip
        url = f"{BASE_URL}/api/profesor-attendance/project/1/date/{FAKE_DATE}"
        r2 = self.s.get(url, timeout=TIMEOUT)
        self.assertEqual(r2.status_code, 200, msg=fmt_resp(r2))
        rows = r2.json()
        matching = [row for row in rows
                    if row.get("student_id") == sid and row.get("pass_type") == "end"]
        self.assertTrue(matching,
                        msg=f"Saved row not found in round-trip GET. rows={rows!r}")
        self.assertEqual(matching[0]["status"], "present")
        self.assertEqual(matching[0]["profesor_id"], SIMON_ID,
                         msg=f"profesor_id should be Simon ({SIMON_ID}), got {matching[0]['profesor_id']}")

    def test_recorded_at_updates_on_resave(self) -> None:
        first = self.students[0]
        sid = first["id"]
        # Save once as 'present'
        payload_a = {
            "projectId": 1, "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": sid, "status": "present"}],
        }
        r1 = self.s.post(f"{BASE_URL}/api/profesor-attendance/bulk", json=payload_a, timeout=TIMEOUT)
        self.assertEqual(r1.status_code, 200, msg=fmt_resp(r1))
        url = f"{BASE_URL}/api/profesor-attendance/project/1/date/{FAKE_DATE}"
        rows1 = self.s.get(url, timeout=TIMEOUT).json()
        match1 = next((r for r in rows1 if r["student_id"] == sid and r["pass_type"] == "end"), None)
        self.assertIsNotNone(match1, msg=f"row missing after first save: {rows1!r}")
        ts1 = match1["recorded_at"]

        # SQLite CURRENT_TIMESTAMP has 1s granularity; sleep so the new write
        # cannot collide with the first.
        time.sleep(1.2)

        # Save again as 'absent' (status flip)
        payload_b = {
            "projectId": 1, "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": sid, "status": "absent"}],
        }
        r2 = self.s.post(f"{BASE_URL}/api/profesor-attendance/bulk", json=payload_b, timeout=TIMEOUT)
        self.assertEqual(r2.status_code, 200, msg=fmt_resp(r2))
        rows2 = self.s.get(url, timeout=TIMEOUT).json()
        match2 = next((r for r in rows2 if r["student_id"] == sid and r["pass_type"] == "end"), None)
        self.assertIsNotNone(match2, msg=f"row missing after second save: {rows2!r}")
        self.assertEqual(match2["status"], "absent", msg=fmt_resp(r2))
        self.assertNotEqual(match2["recorded_at"], ts1,
                            msg=f"recorded_at did not change on resave (was {ts1!r})")


class InputValidationTests(unittest.TestCase):
    """5. Input validation on /bulk and /project/:pid/date/:date."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.s = requests.Session()
        r = login(cls.s, SIMON_ID, password=SHARED_PROFE_PW)
        if r.status_code != 200:
            raise unittest.SkipTest(f"Could not login as Simon: {fmt_resp(r)}")
        # Need a real student to use as the single "good" entry when
        # testing OTHER fields' validation.
        cls.students = get_project_students(cls.s, 1)
        if not cls.students:
            raise unittest.SkipTest("Project 1 has no students.")
        cls.sid = cls.students[0]["id"]

    def _post(self, payload: Dict[str, Any]) -> requests.Response:
        return self.s.post(f"{BASE_URL}/api/profesor-attendance/bulk",
                           json=payload, timeout=TIMEOUT)

    def test_bad_date_format_get(self) -> None:
        # GET /project/1/date/05/15/2026 — slashes collapse to a different
        # route, so we use the dashed-but-wrong-format variant. The route
        # accepts /:date as a single segment; we send "05-15-2026".
        url = f"{BASE_URL}/api/profesor-attendance/project/1/date/05-15-2026"
        r = self.s.get(url, timeout=TIMEOUT)
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_bad_date_format_bulk(self) -> None:
        r = self._post({
            "projectId": 1, "date": "05/15/2026", "passType": "end",
            "entries": [{"student_id": self.sid, "status": "present"}],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_bad_pass_type(self) -> None:
        r = self._post({
            "projectId": 1, "date": FAKE_DATE, "passType": "xxx",
            "entries": [{"student_id": self.sid, "status": "present"}],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_bad_project_id_string(self) -> None:
        r = self._post({
            "projectId": "one", "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": self.sid, "status": "present"}],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_bad_project_id_negative(self) -> None:
        r = self._post({
            "projectId": -3, "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": self.sid, "status": "present"}],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_bad_project_id_zero(self) -> None:
        r = self._post({
            "projectId": 0, "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": self.sid, "status": "present"}],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_empty_entries(self) -> None:
        r = self._post({
            "projectId": 1, "date": FAKE_DATE, "passType": "end", "entries": [],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_malformed_entry_missing_status(self) -> None:
        r = self._post({
            "projectId": 1, "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": self.sid}],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))

    def test_malformed_entry_bad_status(self) -> None:
        r = self._post({
            "projectId": 1, "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": self.sid, "status": "maybe"}],
        })
        self.assertEqual(r.status_code, 400, msg=fmt_resp(r))


class CrossTenantTests(unittest.TestCase):
    """6. Cross-tenant attempt: Simon posts a bulk where one student belongs
    to a different project than `projectId`. We REPORT the result; this is
    a known weakness — the route does not enforce per-entry membership.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.s = requests.Session()
        r = login(cls.s, SIMON_ID, password=SHARED_PROFE_PW)
        if r.status_code != 200:
            raise unittest.SkipTest(f"Could not login as Simon: {fmt_resp(r)}")
        other = find_other_project_student_id(cls.s, exclude_project_id=1)
        if other is None:
            raise unittest.SkipTest("Could not find a student belonging to a non-1 project.")
        cls.other_student_id, cls.other_project_id = other

    def test_post_with_foreign_student(self) -> None:
        payload = {
            "projectId": 1,
            "date": FAKE_DATE,
            "passType": "start",
            "entries": [{"student_id": self.other_student_id, "status": "present"}],
        }
        r = self.s.post(f"{BASE_URL}/api/profesor-attendance/bulk",
                        json=payload, timeout=TIMEOUT)
        # We don't fail the test here regardless of outcome — we report.
        if r.status_code == 200:
            add_finding(
                f"Cross-tenant: POST /bulk with projectId=1 but a student "
                f"(id={self.other_student_id}) from project {self.other_project_id} "
                f"was ACCEPTED ({r.status_code}). Route does not validate per-entry "
                f"student membership against projectId — student gets attributed to "
                f"project 1 in the profesor_attendance row."
            )
        else:
            add_finding(
                f"Cross-tenant: POST /bulk rejected foreign student "
                f"(id={self.other_student_id}, real project={self.other_project_id}) "
                f"with HTTP {r.status_code}. Body: {safe_json(r)!r}"
            )
        # The "test" itself just confirms we exercised the path.
        self.assertIn(r.status_code, (200, 400, 403, 422),
                      msg=f"unexpected status from cross-tenant test: {fmt_resp(r)}")


class CoordinatorAccuracyTests(unittest.TestCase):
    """7. After Simon saves a final pass on project 1 for FAKE_DATE,
    Ronald's GET /compliance for that date should show the project with
    end_recorded_at set and end_profesor_name='Simon Whalley'.
    """

    def test_compliance_reflects_simons_end_save(self) -> None:
        # Simon: save end pass for project 1
        s_simon = requests.Session()
        r = login(s_simon, SIMON_ID, password=SHARED_PROFE_PW)
        self.assertEqual(r.status_code, 200, msg=fmt_resp(r))
        students = get_project_students(s_simon, 1)
        self.assertTrue(students, "project 1 must have students")
        sid = students[0]["id"]
        payload = {
            "projectId": 1, "date": FAKE_DATE, "passType": "end",
            "entries": [{"student_id": sid, "status": "present"}],
        }
        save_r = s_simon.post(f"{BASE_URL}/api/profesor-attendance/bulk",
                              json=payload, timeout=TIMEOUT)
        self.assertEqual(save_r.status_code, 200, msg=fmt_resp(save_r))

        # Ronald: pull compliance for the same date
        s_ron = requests.Session()
        rl = login(s_ron, RONALD_ID, password=SHARED_PROFE_PW)
        self.assertEqual(rl.status_code, 200, msg=fmt_resp(rl))
        comp = s_ron.get(f"{BASE_URL}/api/profesor-attendance/compliance/{FAKE_DATE}",
                         timeout=TIMEOUT)
        self.assertEqual(comp.status_code, 200, msg=fmt_resp(comp))
        rows = comp.json()
        project1 = next((r for r in rows if r.get("project_id") == 1), None)
        self.assertIsNotNone(project1,
                             msg=f"project 1 missing from compliance response. rows={rows!r}")
        self.assertIsNotNone(project1.get("end_recorded_at"),
                             msg=f"end_recorded_at is None on project 1: {project1!r}")
        self.assertEqual(project1.get("end_profesor_name"), "Ronald Fernández Mesén"
                         if False else "Simon Whalley",
                         msg=f"end_profesor_name expected 'Simon Whalley', "
                             f"got {project1.get('end_profesor_name')!r}; row={project1!r}")


class LeaderRoleGatingTests(unittest.TestCase):
    """Bonus per setup notes: a regular leader login route logic should
    require accessCode (not password) before getting a JWT. We attempt
    login with a wrong password and confirm the server tells us we need
    an accessCode (proving the role-branching logic ran), without
    actually getting in.
    """

    def test_leader_role_demands_access_code(self) -> None:
        s = requests.Session()
        leader_id = find_regular_leader_id(s)
        if leader_id is None:
            self.skipTest("No leader-role user in public /api/auth/leaders list.")
        # First attempt: send `password` for a leader role — the server
        # should NOT compare bcrypt; it should branch to accessCode logic.
        r = login(s, leader_id, password="definitely-wrong")
        # Expected: 400 'Access code required' (route branched into the
        # leader path and noticed no accessCode), OR 401 'Invalid access code'
        # if the server were somehow comparing password against accessCode
        # (it should not). Anything 2xx is a critical security failure.
        self.assertNotIn(r.status_code, range(200, 300),
                         msg=f"Leader login with wrong password unexpectedly succeeded: {fmt_resp(r)}")
        if r.status_code == 401:
            # Still acceptable: invalid access code path. But the body should
            # NOT be 'Invalid password' (which would mean it ran the profe path).
            body = safe_json(r)
            if isinstance(body, dict) and body.get("error") == "Invalid password":
                add_finding(
                    "Leader login: server returned 'Invalid password' for a "
                    "role='leader' account — route may be running the bcrypt "
                    "compare path on leader accounts. Expected accessCode path."
                )


# ---------------------------------------------------------------------------
# Custom runner so we can print a clean Total/Passed/Failed summary
# ---------------------------------------------------------------------------

def _shortname(test: unittest.TestCase) -> str:
    return f"{test.__class__.__name__}.{test._testMethodName}"


class RecordingResult(unittest.TextTestResult):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.passed: List[str] = []
        self.failed_details: List[Tuple[str, str]] = []
        self.skipped_details: List[Tuple[str, str]] = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.passed.append(_shortname(test))

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.failed_details.append((_shortname(test), self._exc_info_to_string(err, test)))

    def addError(self, test, err):
        super().addError(test, err)
        self.failed_details.append((_shortname(test), self._exc_info_to_string(err, test)))

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.skipped_details.append((_shortname(test), reason))


def build_suite() -> unittest.TestSuite:
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for cls in (
        LoginShapeTests,
        VerifyShapeTests,
        CoordinatorGateTests,
        ProfesorEndpointTests,
        InputValidationTests,
        CrossTenantTests,
        CoordinatorAccuracyTests,
        LeaderRoleGatingTests,
    ):
        suite.addTests(loader.loadTestsFromTestCase(cls))
    return suite


def main() -> int:
    preflight()
    suite = build_suite()
    runner = unittest.TextTestRunner(
        stream=sys.stdout,
        verbosity=2,
        resultclass=RecordingResult,
    )
    result: RecordingResult = runner.run(suite)  # type: ignore[assignment]

    total = result.testsRun
    failed = len(result.failed_details)
    skipped = len(result.skipped_details)
    passed = len(result.passed)

    print("\n" + "=" * 70)
    print("TEST REPORT")
    print("=" * 70)
    print(f"Total:   {total}")
    print(f"Passed:  {passed}")
    print(f"Failed:  {failed}")
    print(f"Skipped: {skipped}")

    if result.failed_details:
        print("\n--- Failures ---")
        for name, detail in result.failed_details:
            print(f"\n  FAIL: {name}")
            # Show just the AssertionError tail to keep the report tight.
            tail = detail.strip().splitlines()
            useful = [line for line in tail if "AssertionError" in line
                      or line.startswith("AssertionError")
                      or "HTTP " in line
                      or "expected" in line.lower()]
            if useful:
                for line in useful[-6:]:
                    print(f"    {line}")
            else:
                for line in tail[-6:]:
                    print(f"    {line}")

    if result.skipped_details:
        print("\n--- Skipped ---")
        for name, reason in result.skipped_details:
            print(f"  SKIP: {name} — {reason}")

    print("\n--- Findings ---")
    if FINDINGS:
        for i, f in enumerate(FINDINGS, 1):
            print(f"  {i}. {f}")
    else:
        print("  (none)")

    print("=" * 70)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
