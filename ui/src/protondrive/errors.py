"""Application error hierarchy.

This module has ZERO internal imports — it is imported by all other
protondrive modules. Any import from another protondrive file creates
circular dependencies.
"""

from __future__ import annotations


class AppError(Exception):
    """Base error for all application errors."""


class AuthError(AppError):
    """Credential storage/retrieval and auth failures. Never includes the token value."""


class IpcError(AppError):
    """Error in engine IPC communication."""


class ConfigError(AppError):
    """Configuration failures."""


class EngineNotFoundError(AppError):
    """Engine binary or script not found."""
