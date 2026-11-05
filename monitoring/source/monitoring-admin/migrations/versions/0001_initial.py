"""Initial monitoring admin schema."""
from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("identities", sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("provider", sa.String(32), nullable=False), sa.Column("subject", sa.String(255), nullable=False),
                    sa.Column("username", sa.String(128), nullable=False), sa.Column("scopes", sa.JSON(), nullable=False),
                    sa.Column("active", sa.Boolean(), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ux_identity_provider_subject", "identities", ["provider", "subject"], unique=True)
    op.create_table("sessions", sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("identity_id", sa.Integer(), sa.ForeignKey("identities.id", ondelete="CASCADE"), nullable=False),
                    sa.Column("token_hash", sa.String(64), nullable=False, unique=True), sa.Column("csrf_token", sa.String(128), nullable=False),
                    sa.Column("source_ip", sa.String(64), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
                    sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False), sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_sessions_identity_id", "sessions", ["identity_id"])
    op.create_table("login_attempts", sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("username", sa.String(128), nullable=False), sa.Column("source_ip", sa.String(64), nullable=False),
                    sa.Column("success", sa.Boolean(), nullable=False), sa.Column("attempted_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_login_attempt_lookup", "login_attempts", ["username", "source_ip", "attempted_at"])
    op.create_table("jobs", sa.Column("id", sa.String(36), primary_key=True), sa.Column("idempotency_key", sa.String(128), unique=True, nullable=False),
                    sa.Column("job_type", sa.String(32), nullable=False), sa.Column("service_id", sa.String(64), nullable=False),
                    sa.Column("lock_key", sa.String(64), unique=True),
                    sa.Column("status", sa.String(24), nullable=False), sa.Column("requested_by", sa.String(128), nullable=False),
                    sa.Column("source_ip", sa.String(64), nullable=False), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
                    sa.Column("started_at", sa.DateTime(timezone=True)), sa.Column("finished_at", sa.DateTime(timezone=True)),
                    sa.Column("result", sa.JSON()), sa.Column("error_code", sa.String(64)), sa.Column("error_message", sa.Text()))
    op.create_index("ix_jobs_service_id", "jobs", ["service_id"]); op.create_index("ix_jobs_status", "jobs", ["status"])
    op.create_table("audit_events", sa.Column("id", sa.Integer(), primary_key=True),
                    sa.Column("event_type", sa.String(48), nullable=False), sa.Column("username", sa.String(128), nullable=False),
                    sa.Column("source_ip", sa.String(64), nullable=False), sa.Column("target", sa.String(128)),
                    sa.Column("outcome", sa.String(24), nullable=False), sa.Column("job_id", sa.String(36), sa.ForeignKey("jobs.id", ondelete="SET NULL")),
                    sa.Column("details", sa.JSON()), sa.Column("created_at", sa.DateTime(timezone=True), nullable=False))
    op.create_index("ix_audit_events_event_type", "audit_events", ["event_type"]); op.create_index("ix_audit_events_job_id", "audit_events", ["job_id"])
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])


def downgrade() -> None:
    op.drop_table("audit_events"); op.drop_table("jobs"); op.drop_table("login_attempts"); op.drop_table("sessions"); op.drop_table("identities")
