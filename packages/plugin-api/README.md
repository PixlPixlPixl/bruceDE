# @brucede/plugin-api

Versioned contracts shared by the host and native plugins. Plugins use these types to contribute panels and communicate through shared services/events.

Keep this package independent of Cordis internals. Additive API changes are preferred; breaking changes require an `apiVersion` change and an explicit compatibility policy.
