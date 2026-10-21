#!/usr/bin/env python3
"""Fail CI when the pytest run skipped (or xfailed) anything.

The PostgreSQL- and Lua-backed tests skip themselves when initdb/pg_ctl, psql
or a `lua` interpreter is missing, so a green run with skips may have tested
nothing. CI installs everything the suite needs, so any skip means a test did
not run and the job must fail. pytest records skips and xfails (including
module-level importorskip) as <skipped> in its JUnit XML report.

Usage: check_no_skips.py <pytest-junit.xml>
"""
import sys
import xml.etree.ElementTree as ET


def main(path: str) -> int:
    cases = list(ET.parse(path).getroot().iter("testcase"))
    if not cases:
        print(f"::error::{path} records no tests; the suite did not run")
        return 1
    skipped = [(case, mark) for case in cases for mark in case.findall("skipped")]
    if not skipped:
        print(f"{len(cases)} tests recorded, none skipped")
        return 0
    print(f"::error::{len(skipped)} of {len(cases)} tests were skipped or xfailed; "
          "CI requires every test to run")
    for case, mark in skipped:
        name = "::".join(filter(None, (case.get("classname"), case.get("name"))))
        detail = (mark.get("message") or "").strip()
        text = (mark.text or "").strip()
        if text and detail not in text:  # module-level skips keep the reason in the text
            detail = f"{detail} {text}"
        print(f"  {name}: {detail}")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1]))
