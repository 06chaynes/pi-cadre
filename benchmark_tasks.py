"""Benchmark task data: defects injected into psf/requests v2.31.0, and SWE-bench Lite snippets."""

import subprocess
import sys
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent / "requests_repo"

REDIRECT_CHECK = """
from requests.sessions import Session
from requests.models import Request, Response

s = Session()
r1 = Response()
r1.status_code = 302
r1.headers['location'] = 'http://example.com/step2'
r1.url = 'http://example.com/step1'
req = s.prepare_request(Request('POST', 'http://example.com/step1', data={'initial': 'data'}))

def send(r, **kwargs):
    resp = Response()
    resp.url = r.url
    resp.request = r
    if r.url == 'http://example.com/step2':
        resp.status_code = 302
        resp.headers['location'] = 'http://example.com/step3'
    else:
        resp.status_code = 200
    resp.raw = type('Raw', (), {'read': lambda self, *a, **k: b''})()
    return resp

s.send = send
redirects = list(s.resolve_redirects(r1, req))
assert len(redirects) == 2, len(redirects)
assert redirects[1].request.method == 'GET', redirects[1].request.method
assert redirects[1].request.body is None, redirects[1].request.body
"""

TASKS = [
    {
        "id": "TASK-1",
        "title": "Proxy URL Auth Preservation",
        "file": "requests/utils.py",
        "function": "prepend_scheme_if_needed",
        "description": "In `prepend_scheme_if_needed`, when a URL contains authentication credentials (such as user:pass@host or user@host), the authentication part is lost because parse_url does not include auth in netloc. Preserve auth by re-attaching it to netloc if auth is present (e.g. if auth: netloc = '@'.join([auth, netloc])).",
        "original": '    if auth:\n        # parse_url doesn\'t provide the netloc with auth\n        # so we\'ll add it ourselves.\n        netloc = "@".join([auth, netloc])',
        "defect": "    # [DEFECT] auth preservation removed",
        "check": ["-m", "pytest", "tests/test_utils.py", "-k", "test_prepend_scheme_if_needed", "-q"],
    },
    {
        "id": "TASK-2",
        "title": "CA Bundle Environment Fallback",
        "file": "requests/sessions.py",
        "function": "merge_environment_settings",
        "description": "In `Session.merge_environment_settings`, when REQUESTS_CA_BUNDLE and CURL_CA_BUNDLE are empty strings or not set, verify should retain its original passed value rather than becoming None or empty string. Update verify fallback logic to check env vars or fallback to verify (e.g. verify = os.environ.get('REQUESTS_CA_BUNDLE') or os.environ.get('CURL_CA_BUNDLE') or verify).",
        "original": '                    or os.environ.get("CURL_CA_BUNDLE")\n                    or verify\n',
        "defect": '                    or os.environ.get("CURL_CA_BUNDLE")\n',
        "check": ["-m", "pytest", "tests/test_requests.py", "-k", "test_env_cert_bundles", "-q"],
    },
    {
        "id": "TASK-3",
        "title": "URL Credential Unquoting",
        "file": "requests/utils.py",
        "function": "get_auth_from_url",
        "description": "In `get_auth_from_url`, extracted username and password components from the parsed URL must be unquoted using `unquote(...)` (e.g. `auth = (unquote(parsed.username), unquote(parsed.password))`) to correctly decode percent-encoded characters such as %25 or %23.",
        "original": "        auth = (unquote(parsed.username), unquote(parsed.password))",
        "defect": "        auth = (parsed.username, parsed.password)",
        "check": ["-m", "pytest", "tests/test_utils.py", "-k", "test_get_auth_from_url", "-q"],
    },
    {
        "id": "TASK-4",
        "title": "Multi-Hop Redirect State Drift",
        "file": "requests/sessions.py",
        "function": "resolve_redirects",
        "description": "In `Session.resolve_redirects`, when iterating through redirects in the while loop, the request `req` must be updated to `prepared_request` (`req = prepared_request`) before yielding or sending so subsequent redirect iterations do not reuse outdated initial request state.",
        "original": "            # Override the original request.\n            req = prepared_request",
        "defect": "            # [DEFECT] req not overridden",
        "check": ["-c", REDIRECT_CHECK],
    },
]

SCOUT_SCHEMA = {
    "type": "object",
    "properties": {
        "target_file": {"type": "string"},
        "target_function": {"type": "string"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
    },
    "required": ["target_file", "target_function", "confidence"],
}


def reset_repo():
    subprocess.run(["git", "checkout", "-f"], cwd=REPO_DIR, check=True, capture_output=True)


def inject_defect(task):
    path = REPO_DIR / task["file"]
    source = path.read_text()
    if task["original"] not in source:
        raise ValueError(f"{task['id']}: target snippet not found in {path}")
    path.write_text(source.replace(task["original"], task["defect"]))


def verify(task):
    """Runs the task's check in REPO_DIR. Returns (passed, output)."""
    res = subprocess.run([sys.executable, *task["check"]], capture_output=True, text=True, cwd=REPO_DIR)
    return res.returncode == 0, res.stdout + res.stderr


SWE_BENCH_INSTANCES = [
    {
        "instance_id": "django__django-10914",
        "repo": "django/django",
        "problem_summary": "Set default FILE_UPLOAD_PERMISSIONS to 0o644. Currently it defaults to None which causes inconsistent OS file permissions when uploaded.",
        "code_context": """
# The numeric mode to set newly-uploaded files to. The value should be a mode
# you'd pass directly to os.chmod; see https://docs.python.org/library/os.html#files-and-directories.
FILE_UPLOAD_PERMISSIONS = None

# The numeric mode to assign to newly-created directories, when uploading files.
FILE_UPLOAD_DIRECTORY_PERMISSIONS = None
""",
        "ground_truth_fix_keyword": "0o644",
    },
    {
        "instance_id": "pytest-dev__pytest-11143",
        "repo": "pytest-dev/pytest",
        "problem_summary": "Rewrite fails when first expression of file is a number and mistaken as docstring. Check that the constant is strictly a string before treating as docstring.",
        "code_context": """
            if (
                expect_docstring
                and isinstance(item, ast.Expr)
                and isinstance(item.value, ast.Constant)
            ):
                doc = item.value.value
                if self.is_rewrite_disabled(doc):
                    return
""",
        "ground_truth_fix_keyword": "isinstance(item.value.value, str)",
    },
    {
        "instance_id": "psf__requests-1963",
        "repo": "psf/requests",
        "problem_summary": "Session.resolve_redirects copies the original request for all subsequent requests, causing method selection bugs in multi-step redirects. In the loop, req should be updated to prepared_request (`req = prepared_request`).",
        "code_context": """
            if rewindable:
                rewind_body(prepared_request)

            # Override the original request.
            # req not updated
""",
        "ground_truth_fix_keyword": "req = prepared_request",
    },
    {
        "instance_id": "astropy__astropy-12907",
        "repo": "astropy/astropy",
        "problem_summary": "Modeling's separability_matrix does not compute separability correctly for nested CompoundModels. In _cstack, cright slice assignment should be set to right, not 1 (e.g. cright[-right.shape[0]:, -right.shape[1]:] = right).",
        "code_context": """
def _cstack(left, right):
    if isinstance(right, Model):
        cright = _coord_matrix(right, 'right', noutp)
    else:
        cright = np.zeros((noutp, right.shape[1]))
        cright[-right.shape[0]:, -right.shape[1]:] = 1

    return np.hstack([cleft, cright])
""",
        "ground_truth_fix_keyword": "= right",
    },
    {
        "instance_id": "astropy__astropy-14995",
        "repo": "astropy/astropy",
        "problem_summary": "In v5.3, NDDataRef mask propagation fails when one of the operands does not have a mask. The condition checks 'if operand is None:' instead of 'if operand.mask is None:' (e.g. if operand.mask is None: return deepcopy(self.mask)).",
        "code_context": """
        if self.mask is None and operand is not None:
            return deepcopy(operand.mask)
        elif operand is None:
            return deepcopy(self.mask)
        else:
            return handle_mask(self.mask, operand.mask, **kwds)
""",
        "ground_truth_fix_keyword": "operand.mask is None",
    },
]
