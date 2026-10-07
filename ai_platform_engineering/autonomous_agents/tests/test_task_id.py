import re

from autonomous_agents.services.task_id import generate_task_id, slugify_task_name

ID_PATTERN = re.compile(r"^[a-z0-9-]+-[0-9a-f]{4}$")


class TestSlugifyTaskName:
    def test_lowercases_and_hyphenates(self):
        assert slugify_task_name("Daily Incident Summary") == "daily-incident-summary"

    def test_collapses_runs_of_separators(self):
        assert slugify_task_name("Daily   ---  Report!!!") == "daily-report"

    def test_strips_leading_and_trailing_separators(self):
        assert slugify_task_name("  !!Report!!  ") == "report"

    def test_falls_back_when_nothing_survives(self):
        # CJK / emoji names slugify to empty; the id must still be well-formed.
        assert slugify_task_name("日次レポート") == "task"
        assert slugify_task_name("") == "task"

    def test_truncates_to_40_chars_without_trailing_separator(self):
        slug = slugify_task_name("a" * 30 + " " + "b" * 30)
        assert len(slug) <= 40
        assert not slug.endswith("-")


class TestGenerateTaskId:
    def test_matches_the_expected_shape(self):
        assert ID_PATTERN.match(generate_task_id("Daily Report"))

    def test_derives_from_the_name(self):
        assert generate_task_id("Daily Report").startswith("daily-report-")

    def test_is_unique_across_calls(self):
        ids = {generate_task_id("Daily Report") for _ in range(50)}
        assert len(ids) > 1

    def test_empty_name_still_produces_a_valid_id(self):
        task_id = generate_task_id("")
        assert task_id.startswith("task-")
        assert ID_PATTERN.match(task_id)
