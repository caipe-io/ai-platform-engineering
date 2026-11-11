import importlib.util
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("check_pinned_deps", Path(__file__).parents[1] / "check_pinned_deps.py")
assert SPEC is not None and SPEC.loader is not None
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class ConditionalDependencyTests(unittest.TestCase):
    def check_requirement(self, requirement: str, sources: str = "") -> list[str]:
        checker.errors.clear()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "pyproject.toml"
            path.write_text(f'[project.optional-dependencies]\nextra = ["{requirement}"]\n{sources}')
            checker.check_pyproject(path)
        return list(checker.errors)

    def test_workspace_dependency_with_python_marker_is_exempt(self) -> None:
        self.assertEqual(self.check_requirement("local-runtime; python_version >= '3.14'", '[tool.uv.sources]\nlocal-runtime = { path = "../local-runtime", editable = true }\n'), [])

    def test_exact_pin_with_python_marker_is_accepted(self) -> None:
        self.assertEqual(self.check_requirement("example-package==1.2.3; python_version >= '3.14'"), [])

    def test_marker_does_not_exempt_an_unpinned_published_package(self) -> None:
        errors = self.check_requirement("example-package; python_version >= '3.14'")
        self.assertEqual(len(errors), 1)
        self.assertIn("no version specifier", errors[0])

    def test_marker_does_not_hide_a_range(self) -> None:
        errors = self.check_requirement("example-package>=1.2.3; python_version >= '3.14'")
        self.assertEqual(len(errors), 1)
        self.assertIn("unpinned specifier", errors[0])

    def test_workspace_name_normalization_and_extras_remain_supported(self) -> None:
        self.assertEqual(self.check_requirement("local_runtime[optional]; python_version >= '3.14'", '[tool.uv.sources]\nlocal-runtime = { path = "../local-runtime" }\n'), [])


if __name__ == "__main__":
    unittest.main()
