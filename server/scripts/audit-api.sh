#!/bin/bash
# Backend API smoke test. Run after `npm run dev` (server on :3000).
# Usage:  bash scripts/audit-api.sh

set -u
BASE=http://localhost:3000/api
LEADER_CODE=${LEADER_ACCESS_CODE:-EARTHFOREST2026}
ADMIN_PW=${ADMIN_PW:-Admin2026Test}
PROFESOR_PW=${PROFESOR_PW:-Profesor2026}

pass=0
fail=0
warn=0

check() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  local extra="${4:-}"
  if [ "$actual" = "$expected" ]; then
    printf "  \033[32m✓\033[0m %-65s %s\n" "$label" "$actual"
    pass=$((pass+1))
  else
    printf "  \033[31m✗\033[0m %-65s got %s, want %s %s\n" "$label" "$actual" "$expected" "$extra"
    fail=$((fail+1))
  fi
}

note() {
  printf "  \033[33m!\033[0m %s\n" "$1"
  warn=$((warn+1))
}

section() {
  printf "\n\033[1m== %s ==\033[0m\n" "$1"
}

http_status() {
  curl -sS -o /tmp/audit_body -w "%{http_code}" "$@"
}

# ---------------------------------------------------------------------------
section "Health + open endpoints"
check "GET /api/health"             200 "$(http_status $BASE/health)"
check "GET /api/auth/leaders"       200 "$(http_status $BASE/auth/leaders)"
check "GET /api/auth/setup-status"  200 "$(http_status $BASE/auth/setup-status)"

section "Auth: leader flow"
check "POST /login leader no code"     400 "$(http_status -X POST -H 'Content-Type: application/json' -d '{\"leaderId\":3}' $BASE/auth/login)"
check "POST /login leader wrong code"  401 "$(http_status -X POST -H 'Content-Type: application/json' -d '{\"leaderId\":3,\"accessCode\":\"WRONG\"}' $BASE/auth/login)"
LEADER_COOKIE=/tmp/leader_cookie
rm -f $LEADER_COOKIE
check "POST /login leader good code"   200 "$(http_status -c $LEADER_COOKIE -X POST -H 'Content-Type: application/json' -d "{\"leaderId\":3,\"accessCode\":\"$LEADER_CODE\"}" $BASE/auth/login)"
if [ ! -s "$LEADER_COOKIE" ]; then note "Leader cookie file empty after login"; fi
grep -q auth_token "$LEADER_COOKIE" 2>/dev/null && pass=$((pass+1)) && printf "  \033[32m✓\033[0m %-65s cookie set\n" "Leader auth_token cookie present" || (fail=$((fail+1)) && printf "  \033[31m✗\033[0m Leader auth_token cookie NOT set\n")

section "Auth: admin/profesor flows"
check "POST /login admin no pw"        400 "$(http_status -X POST -H 'Content-Type: application/json' -d '{\"leaderId\":2}' $BASE/auth/login)"
check "POST /login admin wrong pw"     401 "$(http_status -X POST -H 'Content-Type: application/json' -d '{\"leaderId\":2,\"password\":\"wrong\"}' $BASE/auth/login)"
ADMIN_COOKIE=/tmp/admin_cookie
rm -f $ADMIN_COOKIE
check "POST /login admin good pw"      200 "$(http_status -c $ADMIN_COOKIE -X POST -H 'Content-Type: application/json' -d "{\"leaderId\":2,\"password\":\"$ADMIN_PW\"}" $BASE/auth/login)"
PROFESOR_COOKIE=/tmp/profesor_cookie
rm -f $PROFESOR_COOKIE
check "POST /login profesor good pw"   200 "$(http_status -c $PROFESOR_COOKIE -X POST -H 'Content-Type: application/json' -d "{\"leaderId\":16,\"password\":\"$PROFESOR_PW\"}" $BASE/auth/login)"

section "Verify + Logout"
check "GET /verify w/ leader cookie"   200 "$(http_status -b $LEADER_COOKIE $BASE/auth/verify)"
check "GET /verify w/o cookie"         401 "$(http_status $BASE/auth/verify)"
check "POST /logout"                   200 "$(http_status -X POST $BASE/auth/logout)"

section "Leader scope: projects"
check "GET own project students"       200 "$(http_status -b $LEADER_COOKIE $BASE/projects/2/students)"
check "GET other project students"     403 "$(http_status -b $LEADER_COOKIE $BASE/projects/1/students)"
check "GET own rotation students"      200 "$(http_status -b $LEADER_COOKIE $BASE/projects/2/current-rotation-students)"
check "GET other rotation students"    403 "$(http_status -b $LEADER_COOKIE $BASE/projects/1/current-rotation-students)"
check "GET available-rotations own"    200 "$(http_status -b $LEADER_COOKIE $BASE/projects/2/available-rotations)"
check "GET available-rotations other"  403 "$(http_status -b $LEADER_COOKIE $BASE/projects/1/available-rotations)"
check "GET alerts low-attendance own"  200 "$(http_status -b $LEADER_COOKIE $BASE/projects/2/alerts/low-attendance)"
check "GET alerts low-attendance other" 403 "$(http_status -b $LEADER_COOKIE $BASE/projects/1/alerts/low-attendance)"

section "Leader scope: student CRUD"
ADD_BODY='{"name":"Audit Test Student","studentId":"TEST123","email":"test@audit.local"}'
RESP=$(curl -sS -b $LEADER_COOKIE -X POST -H 'Content-Type: application/json' -d "$ADD_BODY" $BASE/projects/2/students)
NEW_ID=$(echo "$RESP" | node -e "let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).studentId||'')}catch{console.log('')}})")
if [ -n "$NEW_ID" ]; then
  printf "  \033[32m✓\033[0m %-65s id=%s\n" "POST add student own project" "$NEW_ID"; pass=$((pass+1))
  # Try to update
  check "PUT update student"            200 "$(http_status -b $LEADER_COOKIE -X PUT -H 'Content-Type: application/json' -d '{"name":"Audit Updated","student_id":"TEST123"}' $BASE/projects/students/$NEW_ID)"
  # Try delete from another leader? Skipping - need another cookie
  check "DELETE student own"            200 "$(http_status -b $LEADER_COOKIE -X DELETE $BASE/projects/students/$NEW_ID)"
else
  printf "  \033[31m✗\033[0m POST add student - no id returned\n"; fail=$((fail+1))
fi
check "POST add student other project" 403 "$(http_status -b $LEADER_COOKIE -X POST -H 'Content-Type: application/json' -d "$ADD_BODY" $BASE/projects/1/students)"

section "Leader scope: attendance"
# Try to read someone else's project attendance
check "GET attendance other project"   403 "$(http_status -b $LEADER_COOKIE $BASE/attendance/project/1/date/2026-05-09)"
check "GET attendance own project"     200 "$(http_status -b $LEADER_COOKIE $BASE/attendance/project/2/date/2026-05-09)"
# Try to read student that isn't ours
check "GET student attendance other"   403 "$(http_status -b $LEADER_COOKIE $BASE/attendance/student/1)"

section "Bulk attendance: JWT override"
# Try injecting projectId/leaderId in body - should be ignored
BULK_BODY='{"projectId":99,"leaderId":99,"date":"2027-01-01","time":"08:00","records":[]}'
check "POST bulk empty records"        400 "$(http_status -b $LEADER_COOKIE -X POST -H 'Content-Type: application/json' -d "$BULK_BODY" $BASE/attendance/bulk)"

section "Statistics (auth required)"
check "GET /statistics/overall no auth" 401 "$(http_status $BASE/statistics/overall)"
check "GET /statistics/overall leader"  200 "$(http_status -b $LEADER_COOKIE $BASE/statistics/overall)"
check "GET /statistics/by-project"      200 "$(http_status -b $LEADER_COOKIE $BASE/statistics/by-project)"
check "GET /statistics/history"         200 "$(http_status -b $LEADER_COOKIE $BASE/statistics/history)"
check "GET /statistics/students-detail leader (admin only)" 403 "$(http_status -b $LEADER_COOKIE $BASE/statistics/students-detail)"
check "GET /statistics/students-detail admin" 200 "$(http_status -b $ADMIN_COOKIE $BASE/statistics/students-detail)"

section "Admin endpoints"
check "GET /admin/students leader"      403 "$(http_status -b $LEADER_COOKIE $BASE/admin/students)"
check "GET /admin/students admin"       200 "$(http_status -b $ADMIN_COOKIE $BASE/admin/students)"
check "GET /admin/attendance/:date"     200 "$(http_status -b $ADMIN_COOKIE $BASE/admin/attendance/2026-05-09)"
check "GET /admin/attendance bad date"  400 "$(http_status -b $ADMIN_COOKIE $BASE/admin/attendance/not-a-date)"
check "GET /admin/absences leader"      403 "$(http_status -b $LEADER_COOKIE $BASE/admin/absences)"
check "GET /admin/absences profesor"    200 "$(http_status -b $PROFESOR_COOKIE $BASE/admin/absences)"
check "GET /admin/projects profesor"    200 "$(http_status -b $PROFESOR_COOKIE $BASE/admin/projects)"
check "GET /admin/attendance-summary"   200 "$(http_status -b $PROFESOR_COOKIE $BASE/admin/attendance-summary)"

section "Security headers"
HDRS=$(curl -sS -i $BASE/health | tr -d '\r')
echo "$HDRS" | grep -q "X-Content-Type-Options: nosniff" && pass=$((pass+1)) && printf "  \033[32m✓\033[0m X-Content-Type-Options: nosniff present\n" || (fail=$((fail+1)) && printf "  \033[31m✗\033[0m X-Content-Type-Options missing\n")
echo "$HDRS" | grep -q "Content-Security-Policy" && pass=$((pass+1)) && printf "  \033[32m✓\033[0m CSP header present\n" || note "CSP header absent (dev mode strips it)"
echo "$HDRS" | grep -q "Strict-Transport-Security" && pass=$((pass+1)) && printf "  \033[32m✓\033[0m HSTS present\n" || note "HSTS absent (helmet may have disabled in dev)"

section "Rate limiting on /login"
limited=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13; do
  code=$(http_status -X POST -H 'Content-Type: application/json' -d '{"leaderId":3,"accessCode":"WRONG"}' $BASE/auth/login)
  if [ "$code" = "429" ]; then limited=$i; break; fi
done
if [ "$limited" -gt 0 ] && [ "$limited" -le 12 ]; then
  printf "  \033[32m✓\033[0m %-65s 429 on attempt %d\n" "Rate limit kicks in" "$limited"; pass=$((pass+1))
else
  printf "  \033[31m✗\033[0m Rate limit never triggered after 13 attempts\n"; fail=$((fail+1))
fi

# Summary
printf "\n\033[1mSummary:\033[0m \033[32m%d passed\033[0m, \033[31m%d failed\033[0m, \033[33m%d notes\033[0m\n" "$pass" "$fail" "$warn"
exit $fail
