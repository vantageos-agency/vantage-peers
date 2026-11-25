"""Ed25519 (RFC 8032) verify and sign, with no network and no required dependency.

Used by `enforce-pi-authorization-before-prod-deploy.py` to check a deploy
authorisation OFFLINE, and by `.claude/scripts/sign-deploy-authorization.py` to
produce one. Two backends, same answers:

  "cryptography"  the `cryptography` package's Ed25519 (OpenSSL), when importable.
  "pure-python"   the RFC 8032 section 6 reference algorithm below, bundled, for a
                  station that lacks the package. Variable-time: it is used to
                  VERIFY (public inputs) everywhere, and to sign only where the
                  package is absent.

`backend="auto"` (the default) picks cryptography when it imports and the pure
implementation otherwise. A caller that names a backend gets exactly that one or a
`VerifierUnavailable`: a verifier that is asked for and cannot run is a refusal to
judge, never a silent substitution. Every verify() returns the backend that ran, so
the guard's audit line can say which verifier decided.

Both backends apply the same rules: a 64-byte signature, a 32-byte public key,
S < L (no malleated signature), canonical point encodings, and the non-cofactored
equation [S]B = R + [k]A.

Tested against the RFC 8032 vectors and against each other in
`.claude/hooks/tests/test_enforce_pi_authorization_before_prod_deploy.py`
(`-k offline_signature`).
"""
import hashlib

BACKEND_CRYPTOGRAPHY = "cryptography"
BACKEND_PURE = "pure-python"
BACKENDS = (BACKEND_CRYPTOGRAPHY, BACKEND_PURE)


class VerifierUnavailable(Exception):
    """The requested backend does not exist or cannot be loaded on this station."""


# ---------------------------------------------------------------------------
# RFC 8032 section 6, the reference implementation (extended coordinates).
# ---------------------------------------------------------------------------
_P = 2**255 - 19
_L = 2**252 + 27742317777372353535851937790883648493


def _inv(x: int) -> int:
    return pow(x, _P - 2, _P)


_D = -121665 * _inv(121666) % _P
_SQRT_M1 = pow(2, (_P - 1) // 4, _P)


def _add(p, q):
    a = (p[1] - p[0]) * (q[1] - q[0]) % _P
    b = (p[1] + p[0]) * (q[1] + q[0]) % _P
    c = 2 * p[3] * q[3] * _D % _P
    d = 2 * p[2] * q[2] % _P
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _P, g * h % _P, f * g % _P, e * h % _P)


def _mul(s: int, p):
    q = (0, 1, 1, 0)
    while s > 0:
        if s & 1:
            q = _add(q, p)
        p = _add(p, p)
        s >>= 1
    return q


def _equal(p, q) -> bool:
    if (p[0] * q[2] - q[0] * p[2]) % _P != 0:
        return False
    return (p[1] * q[2] - q[1] * p[2]) % _P == 0


def _recover_x(y: int, sign: int):
    if y >= _P:
        return None
    x2 = (y * y - 1) * _inv(_D * y * y + 1) % _P
    if x2 == 0:
        return None if sign else 0
    x = pow(x2, (_P + 3) // 8, _P)
    if (x * x - x2) % _P != 0:
        x = x * _SQRT_M1 % _P
    if (x * x - x2) % _P != 0:
        return None
    if (x & 1) != sign:
        x = _P - x
    return x


_GY = 4 * _inv(5) % _P
_GX = _recover_x(_GY, 0)
_G = (_GX, _GY, 1, _GX * _GY % _P)


def _compress(p) -> bytes:
    zinv = _inv(p[2])
    x = p[0] * zinv % _P
    y = p[1] * zinv % _P
    return int.to_bytes(y | ((x & 1) << 255), 32, "little")


def _decompress(raw: bytes):
    if len(raw) != 32:
        return None
    y = int.from_bytes(raw, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    if x is None:
        return None
    return (x, y, 1, x * y % _P)


def _sha512_modl(data: bytes) -> int:
    return int.from_bytes(hashlib.sha512(data).digest(), "little") % _L


def _expand(seed: bytes):
    digest = hashlib.sha512(seed).digest()
    scalar = int.from_bytes(digest[:32], "little")
    scalar &= (1 << 254) - 8
    scalar |= 1 << 254
    return scalar, digest[32:]


def _pure_public_key(seed: bytes) -> bytes:
    scalar, _ = _expand(seed)
    return _compress(_mul(scalar, _G))


def _pure_sign(seed: bytes, message: bytes) -> bytes:
    scalar, prefix = _expand(seed)
    public = _compress(_mul(scalar, _G))
    r = _sha512_modl(prefix + message)
    r_enc = _compress(_mul(r, _G))
    k = _sha512_modl(r_enc + public + message)
    s = (r + k * scalar) % _L
    return r_enc + int.to_bytes(s, 32, "little")


def _pure_verify(public: bytes, message: bytes, signature: bytes) -> bool:
    if len(public) != 32 or len(signature) != 64:
        return False
    a_point = _decompress(public)
    if a_point is None:
        return False
    r_enc = signature[:32]
    r_point = _decompress(r_enc)
    if r_point is None:
        return False
    s = int.from_bytes(signature[32:], "little")
    if s >= _L:
        return False
    k = _sha512_modl(r_enc + public + message)
    return _equal(_mul(s, _G), _add(r_point, _mul(k, a_point)))


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
def _cryptography_module():
    """The cryptography Ed25519 module, or raise VerifierUnavailable."""
    try:
        from cryptography.hazmat.primitives.asymmetric import ed25519  # noqa: PLC0415
    except Exception as error:  # ImportError, or a broken install
        raise VerifierUnavailable(
            f"the cryptography package is not usable here ({type(error).__name__}: {error})"
        ) from error
    return ed25519


def resolve_backend(backend: str = "auto") -> str:
    """The concrete backend name for `backend`, or raise VerifierUnavailable."""
    if backend == "auto":
        try:
            _cryptography_module()
            return BACKEND_CRYPTOGRAPHY
        except VerifierUnavailable:
            return BACKEND_PURE
    if backend == BACKEND_PURE:
        return BACKEND_PURE
    if backend == BACKEND_CRYPTOGRAPHY:
        _cryptography_module()
        return BACKEND_CRYPTOGRAPHY
    raise VerifierUnavailable(
        f"unknown Ed25519 backend {backend!r} (known: auto, {', '.join(BACKENDS)})"
    )


def verify(public: bytes, message: bytes, signature: bytes, backend: str = "auto"):
    """(is_valid, backend_that_ran). Never raises on a bad signature, only on a bad BACKEND."""
    name = resolve_backend(backend)
    if len(public) != 32 or len(signature) != 64:
        return False, name
    if name == BACKEND_PURE:
        return _pure_verify(public, message, signature), name
    module = _cryptography_module()
    try:
        module.Ed25519PublicKey.from_public_bytes(public).verify(signature, message)
    except Exception:  # InvalidSignature, or a malformed point: either way, not valid
        return False, name
    return True, name


def public_key(seed: bytes, backend: str = "auto") -> bytes:
    """The raw 32-byte public key of a 32-byte seed."""
    if len(seed) != 32:
        raise ValueError("an Ed25519 seed is exactly 32 bytes")
    if resolve_backend(backend) == BACKEND_PURE:
        return _pure_public_key(seed)
    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415

    key = _cryptography_module().Ed25519PrivateKey.from_private_bytes(seed)
    return key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )


def sign(seed: bytes, message: bytes, backend: str = "auto") -> bytes:
    """The 64-byte Ed25519 signature of `message` under a 32-byte seed."""
    if len(seed) != 32:
        raise ValueError("an Ed25519 seed is exactly 32 bytes")
    if resolve_backend(backend) == BACKEND_PURE:
        return _pure_sign(seed, message)
    return _cryptography_module().Ed25519PrivateKey.from_private_bytes(seed).sign(message)
