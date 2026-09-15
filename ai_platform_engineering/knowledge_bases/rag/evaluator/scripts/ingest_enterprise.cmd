@echo off
setlocal

REM Run EnterpriseRAG-Bench ingestion using the repository defaults.
REM Additional CLI arguments can be passed to override the defaults.

set "REPO_ROOT=%~dp0.."
set "PYTHON_BIN=python"
if not "%PYTHON%"=="" set "PYTHON_BIN=%PYTHON%"

"%PYTHON_BIN%" "%REPO_ROOT%\src\deepeval_eval\ingest\ingest.py" ^
  --data-dir "%REPO_ROOT%\data" ^
  --dataset-name enterprise ^
  --sources confluence jira github hubspot fireflies linear google_drive gmail slack ^
  --limit-per-source 1000 ^
  --num-questions 100 ^
  --questions-per-category 10 ^
  --batch-size 50 ^
  %*

exit /b %ERRORLEVEL%
