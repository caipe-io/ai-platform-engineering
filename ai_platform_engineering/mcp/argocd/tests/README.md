# MCP ArgoCD Tests

This directory contains comprehensive tests for the MCP ArgoCD tools and functionality.

## Test Files

### Core Functionality Tests

- **`test_api_debug_functionality.py`** - Tests API client debug functionality and response handling
- **`test_applications_filter.py`** - Tests application filtering functionality with various criteria
- **`test_applications_none_handling.py`** - Tests proper handling of None data and edge cases in applications
- **`test_api_version.py`** - Tests the version service API functionality
- **`test_projects.py`** - Tests project listing and filtering functionality
- **`test_api_client.py`** - Tests the core API client functionality including request handling

### Test Runner

- **`run_all_tests.py`** - Executes all test files and provides a summary report

## Running Tests

### Prerequisites
For local development, activate the virtual environment:
```bash
# From the project root
source /home/sraradhy/ai-platform-engineering/.venv/bin/activate
```

### Run All Tests
```bash
cd tests/
python run_all_tests.py
```

### Run Individual Tests
```bash
cd tests/
python test_applications_filter.py
python test_api_version.py
# etc.
```

### Running with Virtual Environment (Local Development)
```bash
# Option 1: Activate virtual environment first
source /home/sraradhy/ai-platform-engineering/.venv/bin/activate
cd tests/
python run_all_tests.py

# Option 2: Use virtual environment directly
/home/sraradhy/ai-platform-engineering/.venv/bin/python tests/run_all_tests.py
```

## Test Structure

All tests follow a consistent structure:

1. **Import Setup** - Proper path configuration to import mcp_argocd modules
2. **Mock Usage** - Extensive use of `unittest.mock` to simulate API responses
3. **Edge Case Testing** - Tests for None data, empty responses, and error conditions
4. **Assertions** - Clear assertions with descriptive error messages
5. **Output** - Informative print statements showing test progress

## Test Coverage

The tests cover:

- ✅ **API Client** - Core HTTP request functionality
- ✅ **Applications** - Listing, filtering, and None data handling
- ✅ **Projects** - Project listing and filtering
- ✅ **Version Service** - API version information retrieval
- ✅ **Error Handling** - Proper error response handling
- ✅ **Edge Cases** - None data, empty responses, connection failures

## Mock Strategy

Tests use mocking to:

- Simulate API responses without requiring a live ArgoCD instance
- Test error conditions that would be difficult to reproduce
- Ensure consistent test results regardless of external dependencies
- Speed up test execution

## Adding New Tests

When adding new tests:

1. Follow the naming convention: `test_<functionality>.py`
2. Include proper imports and path setup
3. Use descriptive test function names
4. Add comprehensive assertions
5. Test both success and failure scenarios
6. Include edge cases (None data, empty responses, etc.)

## Dependencies

Tests require:
- Python 3.14
- `unittest.mock` (built-in)
- `asyncio` (built-in)
- `aiohttp` (for API client functionality)

No external test frameworks are required - all tests use Python's built-in testing capabilities.
