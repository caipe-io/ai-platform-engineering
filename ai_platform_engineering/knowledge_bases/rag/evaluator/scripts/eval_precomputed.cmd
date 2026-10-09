@echo off
setlocal

REM Run DeepEval against benchmark ground-truth contexts/reference answers.
REM Additional CLI arguments can be passed to override the defaults.

set "REPO_ROOT=%~dp0.."
set "PYTHON_BIN=python"
if not "%PYTHON%"=="" set "PYTHON_BIN=%PYTHON%"

"%PYTHON_BIN%" "%REPO_ROOT%\src\deepeval_eval\engine\deepeval_evaluator.py" eval ^
  --dataset-name hotpotqa ^
  --oracle-testing ^
  --max-items 20 ^
  %*

exit /b %ERRORLEVEL%
