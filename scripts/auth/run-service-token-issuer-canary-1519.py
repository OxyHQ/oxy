#!/usr/bin/env python3
"""Retired historical Noted credential launcher.

The issuer's external credential probe remains in probe-service-token-issuer-1519.mjs.
It is not an own-workload producer and must use an explicitly authorized external
credential fixture. Never relaunch the old Noted image or inject its retired keys.
"""
import sys


def main():
    raise RuntimeError('The historical Noted credential canary launcher is retired; use current workload canaries or an explicit external credential fixture.')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
