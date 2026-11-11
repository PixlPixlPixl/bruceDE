@echo off
rem Thin wrapper: every step and its up-to-date checks live in scripts\icebox.mjs.
node "%~dp0scripts\icebox.mjs" uninstall %*
