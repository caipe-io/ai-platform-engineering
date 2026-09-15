@echo off
setlocal

REM Run HotpotQA ingestion using the repository defaults.
REM Additional CLI arguments can be passed to override the defaults.

set "REPO_ROOT=%~dp0.."
set "PYTHON_BIN=python"
if not "%PYTHON%"=="" set "PYTHON_BIN=%PYTHON%"

"%PYTHON_BIN%" "%REPO_ROOT%\src\deepeval_eval\ingest\ingest.py" ^
  --data-dir "%REPO_ROOT%\data" ^
  --dataset-name hotpotqa ^
  --limit 100 ^
  --questions-per-category 50 ^
  --max-docs 1000 ^
  --batch-size 50 ^
  %*

exit /b %ERRORLEVEL%
