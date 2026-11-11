@echo off
rem Thin wrapper: installs/builds only what is missing, then runs theia start.
node "%~dp0scripts\icebox.mjs" start electron %*
