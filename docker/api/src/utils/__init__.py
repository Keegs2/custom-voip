"""Shared, dependency-free utilities for the RCF-V1 API.

Currently exposes the canonical phone-number normalizer (``phone``), which is
the single source of truth for turning any accepted phone-number input into the
platform's canonical E.164 form. Keep this package free of framework imports so
it can be unit-tested and reused anywhere in the API.
"""
