@echo off
rem Thin wrapper: reports what is installed, built and up to date.
node "%~dp0scripts\icebox.mjs" status %*
