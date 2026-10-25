"""Validation against the normative Flow assistant JSON Schemas.

The three schemas in ``schemas/`` are BYTE-IDENTICAL copies of
``docs/ivr_assist/*.schema.json`` (the API image's build context is
``docker/api``, so ``docs/`` is not in the image; a test compares the bytes).
They are interpreted directly — there is no hand-written mirror that could
drift from them.

This is a deliberately small JSON Schema (draft 2020-12) evaluator for exactly
the keywords those files use. It FAILS CLOSED: a schema that uses any other
keyword is refused when it is loaded (``SchemaError``), so a contract change
that adds a keyword breaks the build loudly instead of being silently ignored.

Semantics follow the specification for the supported keywords:
  * ``type`` (incl. a list of types); ``integer`` = a number with no fraction
    (``True``/``False`` are never numbers);
  * ``enum`` / ``const`` with JSON equality (``1`` != ``true``);
  * ``pattern`` = an ECMA-262 regex searched anywhere in the string: ``$`` is
    translated to ``\\Z`` (Python's ``$`` also matches before a trailing
    newline) and ``\\d`` is ASCII-only, as in ECMA-262;
  * ``minLength`` / ``maxLength`` count code points;
  * ``properties`` / ``required`` / ``additionalProperties`` (``false`` or a
    schema), ``items``, ``min/maxItems``, ``uniqueItems``, ``oneOf``,
    ``minimum`` / ``maximum``, ``$ref`` to ``#/$defs/<name>``.
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"
SCHEMA_FILES = {
    "alias_graph": "alias_graph.schema.json",
    "request": "assist_request.schema.json",
    "response": "assist_response.schema.json",
}

#: Annotation keywords (no validation effect) + the validation keywords
#: implemented below. Anything else in a schema is refused.
_ANNOTATIONS = frozenset({"$schema", "$id", "title", "description", "$defs"})
_VALIDATION = frozenset({
    "$ref", "type", "enum", "const", "pattern", "minLength", "maxLength", "minItems",
    "maxItems", "uniqueItems", "items", "properties", "required", "additionalProperties",
    "oneOf", "minimum", "maximum",
})
SUPPORTED_KEYWORDS = _ANNOTATIONS | _VALIDATION
_TYPES = frozenset({"object", "array", "string", "integer", "number", "boolean", "null"})

#: Errors reported per validation (the first ones are what matter).
MAX_ERRORS = 20


class SchemaError(Exception):
    """A schema file uses something this evaluator does not implement."""


def ecma_pattern(pattern: str) -> re.Pattern:
    """Compile an ECMA-262 ``pattern`` with matching Python semantics."""
    out: list[str] = []
    i, in_class = 0, False
    while i < len(pattern):
        c = pattern[i]
        if c == "\\":
            out.append(pattern[i:i + 2])
            i += 2
            continue
        if in_class:
            if c == "]":
                in_class = False
            out.append(c)
        elif c == "[":
            in_class = True
            out.append(c)
        elif c == "$":
            out.append(r"\Z")
        else:
            out.append(c)
        i += 1
    return re.compile("".join(out), re.ASCII)


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _json_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    return _canonical(a) == _canonical(b)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _is_type(v: Any, t: str) -> bool:
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "null":
        return v is None
    if t == "number":
        return _is_number(v)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool) or (
            isinstance(v, float) and v.is_integer())
    return False


class Validator:
    """One loaded schema. ``errors(instance)`` -> list of ``"<path>: <why>"``."""

    def __init__(self, schema: Mapping[str, Any]):
        if not isinstance(schema, dict):
            raise SchemaError("a schema must be an object")
        self.root = schema
        self._patterns: dict[str, re.Pattern] = {}
        self._check(schema, "#")

    # -- load-time keyword check ---------------------------------------------
    def _check(self, sch: Any, where: str) -> None:
        if not isinstance(sch, dict):
            raise SchemaError(f"{where}: a subschema must be an object")
        unknown = set(sch) - SUPPORTED_KEYWORDS
        if unknown:
            raise SchemaError(f"{where}: unsupported keyword(s) {sorted(unknown)}")
        for name, sub in (sch.get("$defs") or {}).items():
            self._check(sub, f"{where}/$defs/{name}")
        for name, sub in (sch.get("properties") or {}).items():
            self._check(sub, f"{where}/properties/{name}")
        if "items" in sch:
            self._check(sch["items"], f"{where}/items")
        if isinstance(sch.get("additionalProperties"), dict):
            self._check(sch["additionalProperties"], f"{where}/additionalProperties")
        for i, sub in enumerate(sch.get("oneOf") or []):
            self._check(sub, f"{where}/oneOf/{i}")
        t = sch.get("type")
        for name in (t if isinstance(t, list) else [t] if t is not None else []):
            if name not in _TYPES:
                raise SchemaError(f"{where}: unknown type {name!r}")
        if "$ref" in sch:
            self._resolve(sch["$ref"], where)
        if "pattern" in sch:
            self._pattern(sch["pattern"])

    def _resolve(self, ref: Any, where: str = "") -> Mapping[str, Any]:
        if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
            raise SchemaError(f"{where}: only '#/$defs/<name>' references are supported")
        target = (self.root.get("$defs") or {}).get(ref[len("#/$defs/"):])
        if not isinstance(target, dict):
            raise SchemaError(f"{where}: unresolved reference {ref}")
        return target

    def _pattern(self, pattern: str) -> re.Pattern:
        compiled = self._patterns.get(pattern)
        if compiled is None:
            compiled = self._patterns[pattern] = ecma_pattern(pattern)
        return compiled

    # -- validation ------------------------------------------------------------
    def errors(self, instance: Any) -> list[str]:
        out: list[str] = []
        self._validate(instance, self.root, "$", out)
        return out[:MAX_ERRORS]

    def is_valid(self, instance: Any) -> bool:
        return not self.errors(instance)

    def _validate(self, v: Any, sch: Mapping[str, Any], path: str, out: list[str]) -> None:
        if len(out) >= MAX_ERRORS:
            return
        if "$ref" in sch:
            self._validate(v, self._resolve(sch["$ref"]), path, out)
        t = sch.get("type")
        if t is not None:
            names = t if isinstance(t, list) else [t]
            if not any(_is_type(v, n) for n in names):
                out.append(f"{path}: expected {'/'.join(names)}")
                return
        if "const" in sch and not _json_equal(v, sch["const"]):
            out.append(f"{path}: must be {_canonical(sch['const'])}")
        if "enum" in sch and not any(_json_equal(v, e) for e in sch["enum"]):
            out.append(f"{path}: not one of the allowed values")
        if isinstance(v, str):
            if "minLength" in sch and len(v) < sch["minLength"]:
                out.append(f"{path}: shorter than {sch['minLength']}")
            if "maxLength" in sch and len(v) > sch["maxLength"]:
                out.append(f"{path}: longer than {sch['maxLength']}")
            if "pattern" in sch and not self._pattern(sch["pattern"]).search(v):
                out.append(f"{path}: does not match {sch['pattern']}")
        if _is_number(v):
            if "minimum" in sch and v < sch["minimum"]:
                out.append(f"{path}: below {sch['minimum']}")
            if "maximum" in sch and v > sch["maximum"]:
                out.append(f"{path}: above {sch['maximum']}")
        if isinstance(v, list):
            if "minItems" in sch and len(v) < sch["minItems"]:
                out.append(f"{path}: fewer than {sch['minItems']} items")
            if "maxItems" in sch and len(v) > sch["maxItems"]:
                out.append(f"{path}: more than {sch['maxItems']} items")
            if sch.get("uniqueItems"):
                seen: list[Any] = []
                for item in v:
                    if any(_json_equal(item, s) for s in seen):
                        out.append(f"{path}: items are not unique")
                        break
                    seen.append(item)
            if "items" in sch:
                for i, item in enumerate(v):
                    self._validate(item, sch["items"], f"{path}[{i}]", out)
        if isinstance(v, dict):
            for key in sch.get("required") or []:
                if key not in v:
                    out.append(f"{path}: missing {key}")
            props = sch.get("properties") or {}
            extra = sch.get("additionalProperties", True)
            for key, item in v.items():
                if key in props:
                    self._validate(item, props[key], f"{path}.{key}", out)
                elif extra is False:
                    out.append(f"{path}: unexpected property {key!r}")
                elif isinstance(extra, dict):
                    self._validate(item, extra, f"{path}.{key}", out)
        if "oneOf" in sch:
            matches = 0
            for sub in sch["oneOf"]:
                scratch: list[str] = []
                self._validate(v, sub, path, scratch)
                matches += not scratch
            if matches != 1:
                out.append(f"{path}: must match exactly one allowed shape ({matches} matched)")


@lru_cache(maxsize=None)
def schema_bytes(name: str) -> bytes:
    return (SCHEMA_DIR / SCHEMA_FILES[name]).read_bytes()


@lru_cache(maxsize=None)
def validator(name: str) -> Validator:
    """The loaded validator for ``alias_graph`` | ``request`` | ``response``."""
    return Validator(json.loads(schema_bytes(name)))


def alias_graph_errors(graph: Any) -> list[str]:
    return validator("alias_graph").errors(graph)


def request_errors(payload: Any) -> list[str]:
    """The request schema, plus ``base`` against the alias-graph schema (§2)."""
    errors = validator("request").errors(payload)
    if not errors and isinstance(payload, dict) and payload.get("base") is not None:
        errors = [f"base: {e}" for e in alias_graph_errors(payload["base"])]
    return errors


def response_errors(body: Any) -> list[str]:
    """The response schema, plus a proposal's ``graph`` against the alias graph (§3)."""
    errors = validator("response").errors(body)
    if errors:
        return errors
    result = body["result"]
    if result.get("kind") == "proposal":
        return [f"graph: {e}" for e in alias_graph_errors(result["graph"])]
    return []
