#!/usr/bin/env bash
# Fail a pull request when newly added content contains likely secrets, PII,
# operator-local paths, or private deployment identifiers.
set -euo pipefail

python3 - "$@" <<'PY'
from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path


PATTERNS = (
    (
        "secret",
        "OpenAI or Anthropic API token",
        re.compile(r"\bsk-(?:(?:proj|ant-api\d+)-)?[A-Za-z0-9_-]{20,}\b"),
    ),
    ("secret", "Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b")),
    ("secret", "GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("secret", "AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    (
        "secret",
        "AWS secret access key",
        re.compile(r"\bAWS_SECRET_ACCESS_KEY\s*=\s*['\"]?[A-Za-z0-9/+=]{32,}"),
    ),
    ("secret", "Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b")),
    ("secret", "private-key material", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    (
        "secret",
        "credential assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|private[_-]?key)\b"
            r"\s*[:=]\s*['\"]?[A-Za-z0-9+/=_.-]{16,}"
        ),
    ),
    (
        "secret",
        "environment credential assignment",
        re.compile(
            r"\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*"
            r"['\"]?[A-Za-z0-9+/=_.-]{16,}"
        ),
    ),
    (
        "pii",
        "email address",
        re.compile(r"\b(?P<value>[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b"),
    ),
    (
        "pii",
        "street address",
        re.compile(
            r"\b(?P<value>\d{1,6}\s+[A-Z][A-Za-z0-9.'-]*(?:\s+[A-Z][A-Za-z0-9.'-]*){0,4}\s+"
            r"(?:Ave(?:nue)?|St(?:reet)?|Rd|Road|Dr(?:ive)?|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pl|Place|Ter|Terrace|Pkwy|Parkway|Trl|Trail)\b)",
            re.IGNORECASE,
        ),
    ),
    (
        "pii",
        "person name in a contact field",
        re.compile(
            r"(?i)\b(?:resident|tenant|owner|vendor|applicant|employee|contact)[_-]?(?:full[_-]?)?name\b"
            r"\s*[:=]\s*['\"]?(?P<value>[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z]?[a-z]+)?)"
        ),
    ),
    ("internal", "private deployment hostname", re.compile(r"\b[a-z0-9-]+\.up\.railway\.app\b", re.IGNORECASE)),
)

# Known private identities and backend identifiers are stored only as hashes so
# the public guard does not publish the sensitive strings it is designed to stop.
# CODEOWNERS protects changes to this list and the matcher.
DENIED_HASHES = {
    "4a491af6e004d9aa75afe91e38175e3ea7128ead0eb34357562f87e24384fb61": ("internal", "private backend identifier"),
    "e581976f508084301b9203e1ba021f047239f0a21c455f670cb2fdb72e561461": ("internal", "private backend identifier"),
    "f215d09f570b2799c8adb1eb97df6d67ac2578ca7eee2ad200e336958b9d1bef": ("internal", "private backend identifier"),
    "aaf30431332578d1e9866993cf32eb85c1247008655e71d0ffa85f8e69743c12": ("internal", "private backend identifier"),
    "d87ee7a9133f2741f2803bcdd72728b0ba1e47f1f47cb4773cbdb96bc3c6b769": ("pii", "known private identity"),
    "fb02c1eac055d5fcbb58f20d69efab6f7228b2a312200442f311f139d42b2184": ("pii", "known private identity"),
    "9744130f81d6fe5a419d43cc4e0b46a53a2826ae28a4681a4a07b2c4bc8bf778": ("pii", "known private identity"),
}

ENV_PATH = re.compile(r"(^|/)\.env(?:\.[^/]+)?$")
ENV_EXAMPLES = (".env.example", ".env.sample", ".env.template")
HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")
OPERATOR_HOME = re.compile(r"/" + r"Users/" + r"([^/\s'\"]+)(?=/|[\s'\"]|$)")
OPERATOR_USER_HASHES = {
    "aa30c520168839fc9bfaf94d9e1740fa0bad8b49a73777754fa03663d0912f67",
    "9340b5cf49befaf0830f1e2522026800f5f1e5a7508291e8ff8a9d8306c923b6",
}
ALLOWED_LINE_HASHES = {
    # Synthetic operator-path fixtures. Exact-line hashes prevent broader
    # allowlisting from hiding a real path elsewhere in the same file.
    "tests/sprint7-environment.test.ts": {
        "fbe0920d33b4be9fe7cfacf07536912701c108745ff2aeda17d3c908654b78d5",
        "50da89263ffc4359719ef1dbb7a13a915b5d5a5ac4984066908b780be5649b42",
    },
    "tests/unit/cli/send-telegram-normalize.test.ts": {
        "eaa65f4f4413302e9700dcd83b397fc49d717e76485401596a1c72b91a41d4fe",
        "00bb1357ce68a0ad0e852d76725d7fdcfc1c9c7895c904a43ad8758298f59921",
        "6ccae987323370a6f7099da7473071f8d0d3fa99a26814cc9705824457019b8d",
    },
    "tests/leak-guard.test.sh": {
        # The canonical post-incident test constructs the operator name from
        # split strings so it can prove the detector without publishing a
        # contiguous private identity.
        "a8541b5ebe72050d88ea5e1d11494f85cf254d79a20f18123125041feb31478b",
    },
    "dashboard/src/app/api/media/__tests__/media-route.test.ts": {
        # Deliberate fake PEM header used to test exfiltration protection.
        "83254faea60a79ae894be47cc5d7f018c89dd2024cdb072be6e40ea29b95017d",
    },
}
ROSTER_CRON_ROW = re.compile(
    r"^\s*\|\s*[A-Za-z][A-Za-z0-9_-]*\s*\|\s*\d+\s*\|.*"
    r"(?:heartbeat\(\d+[hm]\)|(?:morning|evening)-review\([^)]*\*[^)]*\))",
    re.IGNORECASE,
)
# SHA-256 digests of lowercase fleet agent names. The scanner hashes whole
# identifier tokens before comparison so substrings never become roster hits.
# CODEOWNERS protects this identity set and its matcher.
ROSTER_NAME_HASHES = {
    "0df89317e02535902d116be0f27294a75145339bf4af53fb35131aea8071a0e1",
    "0357513deb903a056e74a7e475247fc1ffe31d8be4c1d4a31f58dd47ae484100",
    "2b7847b7b705781d7cf21a05e9c1bb37cbf078aea103bc3edcc6aca52ab65453",
    "ed62c6fd9f1b99007f2f0e108e1c5c97184fa69f3c43feb8038b389d80896476",
    "7f0b629cbb9d794b3daf19fcd686a30a039b47395545394dadc0574744996a87",
    "5af2ce87460cec2056d0bdbe9fb8dda57462e3d4074d9aeea537c3638048e895",
    "16477688c0e00699c6cfa4497a3612d7e83c532062b64b250fed8908128ed548",
    "fcb758b78074e8274889be3114a8bf507914641f63dd9efc7fa65a414f7c0480",
    "969d9377fbf980082dcdfbcf57ceab1e0af76b40af96f6fded61b8dc76998272",
    "8472638c24e61364a5cfbe3bb146f22058212be6aedd4fea0c78e27aa30d2ebc",
    "3782208ea47adc401de2df91494d5b3653d7be671dec6d6cd84677ff2fa7b972",
    "ab0fcec08e18a7bccda1e81df4974e3434fcd36000518f7e776fb85495b5a494",
}
PIPE_ROW = re.compile(r"^[ \t]*\|")
CADENCE_EXPR = re.compile(
    r"heartbeat\(\d|pr-monitor\(\d|\(\d+ [\d*]+ \* \* |"
    r"(?:^|[^\d*,/-])[\d*][\d*,/-]* [\d*][\d*,/-]* [\d*][\d*,/-]* "
    r"[\d*][\d*,/-]* [\d*][\d*,/-]*(?:[^\d*,/-]|$)"
)
FORMATTED_PHONE = re.compile(
    r"(?<!\d)(?P<value>(?:\+?1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]\d{3}[ .-]\d{4})(?!\d)"
)
BARE_PHONE = re.compile(r"(?<!\d)(?P<value>[2-9]\d{9})(?!\d)")
PHONE_CONTEXT = re.compile(r"\b(?:phone|call|callback|contact|mobile|sms|texting)\b", re.IGNORECASE)
PUBLISHED_SUPPORT_IDENTIFIER_HASHES = {
    # Deliberate public support-access identity. Members grant this ID access
    # when requesting product support. Changing it is a product decision.
    "e0c17860efbc7dbbb6a18488dda85c849bfefc517c4505766cfe81b7600429a0",
}

# Exact-value hashes for documented synthetic or deliberately published values.
# Hashing keeps the guard from matching its own allowlist as content. Adding a
# value requires owner review and a reason in the change that introduced it.
ALLOWED_PII_HASHES = {
    "email address": {
        "2ebf2e2f8386685e7506603bffba167ad7f3fe15b315abeed8bdb48039ff1206",
        "b5b6d07d472034a2c72c1ae6ca3fab6c2016930172ea8350171d6341b17e369d",
        "6b583232e99af45c3b436798f32800a4dd6f3524624ba6507ed8269b53ce82a3",
        "3de132cd98be7bf26b6f08e81c31c799a891bc32046b61f0b6fe3671ca2e44b5",
        "cd29c5ac348a026a3ec5286890908fffb5bf6ab77f20672171be323a70c95026",
        "e410019b92a93394b9cfb4c20464e0b60784beb5b98c8178ead2d3ae2b2b25dc",
        "f660ab912ec121d1b1e928a0bb4bc61b15f5ad44d5efdc4e1c92a25e99b8e44a",
        "b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514",
        "ff9c8750d0b6f7b9eef7d963d834178cf3f70d30ade220f74b094c0fbddea1f6",
        "53e6cdc30765aade0129f85e5aeb50124b1d3f5bb9a70373be31e4eb328371e0",
        "456c688d0b08431b2139c54ea4bccf136aec4095db7eac90d3a6f551014480de",
    },
    "street address": {
        "f712f8dca061f16b08faf715c4be4949c34d77615475db0bf34773b990106479",
        "59593a39a6420387dd7e50343e073af6e4e626e15c84a0c86523187f39e4892c",
        "29f099c33810ae014175cf2f74a02ce406b6df3d0430768218cb833c2905804e",
        "7f4b955d70e7d138475d3de1ced3897fe61d505e90aa71f1129379d3661c9bbe",
        "62fb6b3d52c778154f4cec3dbcc029a1a516303a554dbbfc9f4029609303ad04",
        "319c89a35a13b489c37aaab6668966b614f447716ba55b299e2a305c525bb529",
        "d061168b38a647315473132ec5178e5d49199d60dc20214d355b9afa91a884e0",
        "a00239066a73ef187ed0182f300692782213f432a25be8370b67c69f54931ff2",
        "320d43657a0eb0b761058b2883d8c805bb114234aacd4487e3d712f001fe5723",
        "f76e40950bab31672982f7dd71e31e640305bce72323469595d0060019e33640",
        "5d641a03d972fa80094f485a9fce60787d1f9d23d3b22daa7ca7824e90929928",
        "ceaf252dbe19f8f59a78090b2c0c60e982be6cf0ef6e3c86e3a0625e2518ee79",
        "e13d5a3e002efca1c194de2669e589b40fb11cb504374d53e354ce004401a362",
        "c56a092e33fef672c4d8658e31ad4b17e8ceac569d5a88ca481846966d364fe5",
        "ab917b33164e7e32e0d028fbd1e4b495397a180cc0cf3385f9df2ccb1aa1b340",
        "989d73b5ae56b0acd09210e6118e546656677c34986f8698aea0099ce7f7a6a0",
        "a9d7d08f5938093d2383e32699b2a66a5e45cd09e9aea76bb472c24f623393d7",
        "0e0331f2393526901b6511363ccc11ead2cf712e5f0e2a3267a253017f35c5e3",
        "3e8c181260bc0130d72af1f96e1351372be616bc25a3ddaa4ec8bdc6fd9d6f69",
        "bb2c5a587a5640d7595ce200c515c743e9a1d7a370c2c1ad66cc9e3a28a5e620",
        "fe7cfd9631e57ec90daad5af2c6fa4e498a4a53ffa0c8acf0b31c5ca3a6ae54f",
        "3c679711151a783ce5a019b90a7272b08257ebccac3e77d715abb2e16992bd4c",
        "8de497618b9b1135c7157ab858a644f3ca2aa65476d2b166ca0c0b4a8ae6b9cf",
        "be56871b700fd6b904ce036fb5f0ef3af6d23818f9d51d2799eef819f37ec79e",
        "b74058f3418af46eef1dbbafa6e127b06d3ccc84ad26aabdbbc5c0f2f9ddec3f",
        "d70165aff818944b228150def17c930be9133317b1bf0ebd49a12fe9a81635a2",
        "02bc53e16ef1e5537093e9fd8549a88ef41bd7d23af39a773d4d336a1ad5b7b3",
        "d88fc1704fedeef6be78e2d4ce34d939a4f6b7a075fccf9595ac79e2a637054d",
        "4f03663a310b5a1814beacbeaab89f843b6576bf0e41d87cc66a764d8e5e08e9",
        "ae1ddceda79c0432ca4b8898c5042f27491d22eb239c82ca30049c533ad7efc1",
        "d340bf8dade4299bea52ca180b1b1713aa6258128d9daa8829f46b4face51d05",
    },
    "person name in a contact field": {
        # Deliberately generic vendor-pattern examples used by the public runtime.
        "f95c49990f904278d33c02a0934a6ac1c3e997952e772415c0ccd15fbde3ba1e",
        "e84413066553932b8ebda406807d6949991e2964001e792f5ce829947dd79aa2",
        "e88741d04cf5fcfd04b5c5e86598acd66483d7b67cab22e025633fbda94f9016",
        "9b52c2a1b23e0923fc37154b2bd3afed5400485e2f24a52ee6b67915f3586732",
    },
}


def is_tracked_private_runtime(path: str) -> bool:
    match = re.search(r"(?:^|/)(orgs/[^/]+/.+)$", path, re.IGNORECASE)
    if not match:
        return False
    org_path = match.group(1)
    if re.match(r"orgs/[^/]+/knowledge\.md$", org_path, re.IGNORECASE):
        return False
    if re.match(r"orgs/[^/]+/docs/durable/", org_path, re.IGNORECASE):
        return False
    if re.match(r"orgs/[^/]+/research-artifacts/\.gitignore$", org_path, re.IGNORECASE):
        return False
    return True


def normalized_repo_path(path: str) -> str:
    normalized = path.replace(os.sep, "/")
    if not os.path.isabs(path):
        return normalized.removeprefix("./")
    try:
        return Path(path).resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return normalized


def allowed_line(path: str, text: str) -> bool:
    repo_path = normalized_repo_path(path)
    line_hash = hashlib.sha256(text.strip().encode()).hexdigest()
    return line_hash in ALLOWED_LINE_HASHES.get(repo_path, set())


def allowed_pii(reason: str, value: str) -> bool:
    value_hash = hashlib.sha256(value.strip().lower().encode()).hexdigest()
    return value_hash in ALLOWED_PII_HASHES.get(reason, set())


def fictional_phone(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) != 10:
        return False
    return digits[3:6] == "555" and 100 <= int(digits[6:]) <= 199


def published_support_identifier(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    return hashlib.sha256(digits.encode()).hexdigest() in PUBLISHED_SUPPORT_IDENTIFIER_HASHES


def safe_secret_example(value: str) -> bool:
    lowered = value.lower()
    references = (
        "process.env", "settings.", "account.", "acct.", "tokens.", "parsed.",
        "credentials.", "savedenv.", "env.", "=e.", "=r.", "original",
        "your", "test", "fake", "placeholder", "not-a-valid", "xxxx",
        "tok_", "super-secret", "storage_key",
    )
    return any(marker in lowered for marker in references)


def is_test_path(path: str) -> bool:
    normalized = "/" + normalized_repo_path(path)
    return (
        normalized.startswith("/tests/")
        or "/__tests__/" in normalized
        or "/fixtures/" in normalized
        or re.search(r"\.(?:test|spec)\.[^/]+$", normalized) is not None
    )


def fail(message: str, code: int = 2) -> "None":
    print(f"leak-guard: ERROR: {message}", file=sys.stderr)
    raise SystemExit(code)


def git(*args: str, binary: bool = False) -> str | bytes:
    result = subprocess.run(
        ["git", *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=not binary,
    )
    if result.returncode:
        stderr = result.stderr.decode(errors="replace") if binary else result.stderr
        fail(f"git {' '.join(args)} failed: {stderr.strip()}")
    return result.stdout


def changed_paths(base: str, head: str) -> list[str]:
    raw = git("diff", "--name-only", "-z", "--diff-filter=ACMRTUXB", f"{base}...{head}", binary=True)
    assert isinstance(raw, bytes)
    return [entry.decode("utf-8", errors="surrogateescape") for entry in raw.split(b"\0") if entry]


def added_lines(base: str, head: str, path: str) -> list[tuple[int, str]]:
    patch = git("diff", "--no-ext-diff", "--unified=0", f"{base}...{head}", "--", path)
    assert isinstance(patch, str)
    patch_lines = patch.splitlines()
    if any(
        line == "GIT binary patch" or (line.startswith("Binary files ") and line.endswith(" differ"))
        for line in patch_lines
    ):
        return [(0, "__BINARY_CONTENT__")]

    lines: list[tuple[int, str]] = []
    next_line: int | None = None
    for raw in patch_lines:
        match = HUNK.match(raw)
        if match:
            next_line = int(match.group(1))
            continue
        if next_line is None:
            continue
        if raw.startswith("+") and not raw.startswith("+++"):
            lines.append((next_line, raw[1:]))
            next_line += 1
        elif raw.startswith("-") and not raw.startswith("---"):
            continue
        elif raw.startswith("\\ No newline"):
            continue
        else:
            next_line += 1
    return lines


def file_lines(path: str) -> list[tuple[int, str]]:
    try:
        data = Path(path).read_bytes()
    except OSError as exc:
        fail(f"cannot read {path}: {exc}")
    if b"\0" in data:
        return [(0, "__BINARY_CONTENT__")]
    return list(enumerate(data.decode("utf-8", errors="replace").splitlines(), start=1))


def scan(path: str, lines: list[tuple[int, str]]) -> list[tuple[str, int, str, str]]:
    hits: list[tuple[str, int, str, str]] = []
    normalized = path.replace(os.sep, "/")
    basename = normalized.rsplit("/", 1)[-1]
    if is_tracked_private_runtime(normalized):
        hits.append((path, 0, "internal", "private runtime path is tracked"))
    if ENV_PATH.search(normalized) and not basename.endswith((".example", ".sample", ".template")):
        hits.append((path, 0, "env-file", "tracked .env content"))
    roster_cron_hit = False
    last_name_line: int | None = None
    last_cron_line: int | None = None
    window_hit_line: int | None = None
    for line_number, text in lines:
        if text == "__BINARY_CONTENT__":
            continue
        if allowed_line(path, text):
            continue
        for match in OPERATOR_HOME.finditer(text):
            username_hash = hashlib.sha256(match.group(1).lower().encode()).hexdigest()
            if username_hash in OPERATOR_USER_HASHES:
                hits.append((path, line_number, "pii", "operator home path"))
        if not is_test_path(path) and ROSTER_CRON_ROW.search(text):
            hits.append((path, line_number, "internal", "agent roster and cron schedule"))
            roster_cron_hit = True
        # Windowed scanning is intentionally limited to table rows. In --diff
        # mode it sees only added lines, so a new name beside a pre-existing
        # cadence row can be missed; --tree scans have no such gap.
        if not is_test_path(path) and PIPE_ROW.search(text):
            lowered = text.lower()
            identifiers = re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", lowered)
            if any(hashlib.sha256(identifier.encode()).hexdigest() in ROSTER_NAME_HASHES for identifier in identifiers):
                last_name_line = line_number
            if CADENCE_EXPR.search(lowered):
                last_cron_line = line_number
            if (
                last_name_line is not None
                and last_cron_line is not None
                and abs(last_name_line - last_cron_line) <= 3
                and window_hit_line is None
            ):
                window_hit_line = line_number
        pii_exempt = "/vendor/" in f"/{normalized.lstrip('/')}"
        phone_matches = list(FORMATTED_PHONE.finditer(text))
        if PHONE_CONTEXT.search(text):
            phone_matches.extend(BARE_PHONE.finditer(text))
        for match in phone_matches:
            value = match.group("value")
            if not pii_exempt and not fictional_phone(value) and not published_support_identifier(value):
                hits.append((path, line_number, "pii", "US phone number outside reserved 555-01XX fixture range"))
        for category, reason, pattern in PATTERNS:
            if category == "pii" and pii_exempt:
                continue
            for match in pattern.finditer(text):
                value = match.groupdict().get("value") or match.group(0)
                if category == "pii" and allowed_pii(reason, value):
                    continue
                if category == "secret" and safe_secret_example(value):
                    continue
                hits.append((path, line_number, category, reason))
                break
        identifiers = re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", text.lower())
        hash_candidates = set(identifiers)
        for identifier in identifiers:
            parts = identifier.split("_")
            hash_candidates.update("_".join(parts[:size]) for size in range(2, len(parts) + 1))
        words = re.findall(r"[A-Za-z][A-Za-z'-]+", text.lower())
        hash_candidates.update(" ".join(words[index : index + 2]) for index in range(max(0, len(words) - 1)))
        for candidate in hash_candidates:
            match = DENIED_HASHES.get(hashlib.sha256(candidate.encode()).hexdigest())
            if match:
                category, reason = match
                hits.append((path, line_number, category, reason))
    if window_hit_line is not None and not roster_cron_hit:
        hits.append((path, window_hit_line, "internal", "agent roster and cron schedule within 3 lines"))
    return hits


def usage() -> "None":
    fail("usage: leak-guard.sh --diff <base> <head> | --tree <ref> | <file> [...]", 2)


args = sys.argv[1:]
if not args:
    usage()

targets: list[tuple[str, list[tuple[int, str]]]] = []
if args[0] == "--diff":
    if len(args) != 3:
        usage()
    base, head = args[1], args[2]
    for path in changed_paths(base, head):
        targets.append((path, added_lines(base, head, path)))
elif args[0] == "--tree":
    if len(args) != 2:
        usage()
    ref = args[1]
    raw = git("ls-tree", "-r", "-z", ref, binary=True)
    assert isinstance(raw, bytes)
    for item in raw.split(b"\0"):
        if not item:
            continue
        metadata, separator, raw_path = item.partition(b"\t")
        if not separator:
            fail(f"unexpected git ls-tree record: {item!r}")
        fields = metadata.split()
        if len(fields) != 3 or fields[1] != b"blob":
            continue
        path = raw_path.decode("utf-8", errors="surrogateescape")
        content = git("show", f"{ref}:{path}", binary=True)
        assert isinstance(content, bytes)
        lines = [(0, "__BINARY_CONTENT__")] if b"\0" in content else list(
            enumerate(content.decode("utf-8", errors="replace").splitlines(), start=1)
        )
        targets.append((path, lines))
elif args[0].startswith("-"):
    usage()
else:
    for path in args:
        targets.append((path, file_lines(path)))

all_hits: list[tuple[str, int, str, str]] = []
for path, lines in targets:
    all_hits.extend(scan(path, lines))

if all_hits:
    print(f"leak-guard: FAIL, {len(all_hits)} potential leak(s) found", file=sys.stderr)
    for path, line, category, reason in all_hits:
        safe_path = path.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::error file={safe_path},line={max(line, 1)}::{category}: {reason}", file=sys.stderr)
    raise SystemExit(1)

print(f"leak-guard: clean, scanned {len(targets)} changed file(s)")
PY
