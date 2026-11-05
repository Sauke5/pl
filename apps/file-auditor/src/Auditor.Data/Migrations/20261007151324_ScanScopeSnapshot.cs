using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Auditor.Data.Migrations
{
    /// <inheritdoc />
    public partial class ScanScopeSnapshot : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "ScanRootSelections",
                columns: table => new
                {
                    AuditRunId = table.Column<long>(type: "INTEGER", nullable: false),
                    RootName = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ScanRootSelections", x => new { x.AuditRunId, x.RootName });
                    table.ForeignKey(
                        name: "FK_ScanRootSelections_AuditRuns_AuditRunId",
                        column: x => x.AuditRunId,
                        principalTable: "AuditRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "ScanThresholdSnapshots",
                columns: table => new
                {
                    AuditRunId = table.Column<long>(type: "INTEGER", nullable: false),
                    WarningPathLength = table.Column<int>(type: "INTEGER", nullable: false),
                    BadPathLength = table.Column<int>(type: "INTEGER", nullable: false),
                    CriticalPathLength = table.Column<int>(type: "INTEGER", nullable: false),
                    LongNameLength = table.Column<int>(type: "INTEGER", nullable: false),
                    MaxDepth = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ScanThresholdSnapshots", x => x.AuditRunId);
                    table.ForeignKey(
                        name: "FK_ScanThresholdSnapshots_AuditRuns_AuditRunId",
                        column: x => x.AuditRunId,
                        principalTable: "AuditRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "ScanRootSelections");

            migrationBuilder.DropTable(
                name: "ScanThresholdSnapshots");
        }
    }
}
