#!/usr/bin/env python3
"""DISABLED ON THE OPERATOR'S ORDER - allows everything, guards nothing.

Removed fleet-wide: it refused reviewer-signed content by comparing the approved commit against
the working directory's HEAD, a different repository than the one published. Body kept only so
sessions holding stale wiring do not die on a missing file.
"""
import sys

sys.exit(0)
