"""Fixed public categories for private bootstrap logs; never publish raw errors."""
import re


def failure_diagnostic(raw):
    text = raw.decode('utf-8', errors='replace')
    if re.search(r'extension ["\']postgis["\'] is not available|postgis\.control.*No such file', text):
        return {'category': 'required_postgis_unavailable'}
    if re.search(r'extension ["\']pg_trgm["\'] is not available|pg_trgm\.control.*No such file', text):
        return {'category': 'required_pg_trgm_unavailable'}
    if 'Cannot find module' in text or 'Cannot find package' in text or 'ResolveMessage' in text:
        return {'category': 'module_resolution_failed'}
    return {'category': 'bootstrap_command_failed'}


def required_extensions(rows):
    assert set(rows) == {'postgis', 'pg_trgm'}, 'Required bootstrap extensions unavailable'
    assert all(isinstance(version, str) and re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,3}', version) for version in rows.values()), 'Unexpected extension version shape'
    return rows
