"""Initial websites-admin schema.

Revision ID: 0001_initial
Revises:
Create Date: 2026-07-14
"""

from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("password_hash", sa.String(length=512), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username", name="uq_users_username"),
    )
    op.create_table(
        "sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("csrf_token", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_ip", sa.String(length=64), nullable=False),
        sa.UniqueConstraint("token_hash", name="uq_sessions_token_hash"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_table(
        "login_attempts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("source_ip", sa.String(length=64), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_login_attempts_lookup", "login_attempts", ["username", "source_ip", "attempted_at"])
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("operation_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("username", sa.String(length=64), nullable=False),
        sa.Column("operation", sa.String(length=48), nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("old_values", sa.JSON(), nullable=True),
        sa.Column("new_values", sa.JSON(), nullable=True),
        sa.Column("forced", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("source_ip", sa.String(length=64), nullable=False),
        sa.Column("validation_status", sa.String(length=32), nullable=False),
        sa.Column("reload_status", sa.String(length=32), nullable=False),
        sa.Column("verification_status", sa.String(length=32), nullable=False),
        sa.Column("rollback", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("notification_status", sa.String(length=32), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("technical_error", sa.Text(), nullable=True),
        sa.UniqueConstraint("operation_id", name="uq_audit_operation_id"),
    )
    op.create_index("ix_audit_created_at", "audit_events", ["created_at"])
    op.create_index("ix_audit_url", "audit_events", ["url"])
    op.create_table(
        "operation_details",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("audit_event_id", sa.Integer(), sa.ForeignKey("audit_events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stage", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("details", sa.JSON(), nullable=True),
    )
    op.create_index("ix_operation_details_audit", "operation_details", ["audit_event_id"])
    op.create_table(
        "backup_index",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("snapshot_name", sa.String(length=128), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("operation", sa.String(length=48), nullable=False),
        sa.Column("url", sa.Text(), nullable=True),
        sa.Column("result", sa.String(length=32), nullable=False),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
        sa.UniqueConstraint("snapshot_name", name="uq_backup_snapshot_name"),
    )
    op.create_table(
        "operation_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(length=48), nullable=False),
        sa.Column("target", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("token_hash", name="uq_operation_tokens_token_hash"),
    )


def downgrade() -> None:
    op.drop_table("operation_tokens")
    op.drop_table("backup_index")
    op.drop_index("ix_operation_details_audit", table_name="operation_details")
    op.drop_table("operation_details")
    op.drop_index("ix_audit_url", table_name="audit_events")
    op.drop_index("ix_audit_created_at", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index("ix_login_attempts_lookup", table_name="login_attempts")
    op.drop_table("login_attempts")
    op.drop_index("ix_sessions_user_id", table_name="sessions")
    op.drop_table("sessions")
    op.drop_table("users")
