@echo off
setlocal

REM Run EnterpriseRAG-Bench evaluation using the repository defaults.
REM Additional CLI arguments can be passed to override the defaults.

set "REPO_ROOT=%~dp0.."
set "PYTHON_BIN=python"
if not "%PYTHON%"=="" set "PYTHON_BIN=%PYTHON%"

"%PYTHON_BIN%" "%REPO_ROOT%\src\deepeval_eval\engine\deepeval_evaluator.py" eval ^
  --dataset-name enterprise ^
  --max-items 10 ^
  --top-k 3 ^
  --max-context-chars 6000 ^
  %*

exit /b %ERRORLEVEL%
