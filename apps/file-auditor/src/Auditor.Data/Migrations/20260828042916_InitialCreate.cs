using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Auditor.Data.Migrations
{
    /// <inheritdoc />
    public partial class InitialCreate : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "AuditRuns",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    StartedAtUtc = table.Column<DateTime>(type: "TEXT", nullable: false),
                    FinishedAtUtc = table.Column<DateTime>(type: "TEXT", nullable: true),
                    TotalObjects = table.Column<long>(type: "INTEGER", nullable: false),
                    ProblemObjects = table.Column<long>(type: "INTEGER", nullable: false),
                    CriticalPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    BadPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    WarningPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    MaxPathLength = table.Column<int>(type: "INTEGER", nullable: false),
                    HygieneScore = table.Column<int>(type: "INTEGER", nullable: false),
                    ScannerDurationMs = table.Column<long>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_AuditRuns", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "BranchSnapshots",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    AuditRunId = table.Column<long>(type: "INTEGER", nullable: false),
                    DepartmentKey = table.Column<string>(type: "TEXT", nullable: false),
                    RelativePath = table.Column<string>(type: "TEXT", nullable: false),
                    TotalObjects = table.Column<long>(type: "INTEGER", nullable: false),
                    ProblemObjects = table.Column<long>(type: "INTEGER", nullable: false),
                    CriticalPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    BadPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    WarningPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    MaxPathLength = table.Column<int>(type: "INTEGER", nullable: false),
                    MaxDepth = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_BranchSnapshots", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "DepartmentSnapshots",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    AuditRunId = table.Column<long>(type: "INTEGER", nullable: false),
                    DepartmentKey = table.Column<string>(type: "TEXT", nullable: false),
                    DepartmentName = table.Column<string>(type: "TEXT", nullable: false),
                    TotalObjects = table.Column<long>(type: "INTEGER", nullable: false),
                    ProblemObjects = table.Column<long>(type: "INTEGER", nullable: false),
                    CriticalPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    BadPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    WarningPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    LongNames = table.Column<long>(type: "INTEGER", nullable: false),
                    DeepPaths = table.Column<long>(type: "INTEGER", nullable: false),
                    CauseLongParent = table.Column<long>(type: "INTEGER", nullable: false),
                    CauseDeepTree = table.Column<long>(type: "INTEGER", nullable: false),
                    CauseLongName = table.Column<long>(type: "INTEGER", nullable: false),
                    CauseMixed = table.Column<long>(type: "INTEGER", nullable: false),
                    MaxPathLength = table.Column<int>(type: "INTEGER", nullable: false),
                    MaxDepth = table.Column<int>(type: "INTEGER", nullable: false),
                    HygieneScore = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DepartmentSnapshots", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DepartmentSnapshots_AuditRuns_AuditRunId",
                        column: x => x.AuditRunId,
                        principalTable: "AuditRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AuditRuns_StartedAtUtc",
                table: "AuditRuns",
                column: "StartedAtUtc");

            migrationBuilder.CreateIndex(
                name: "IX_BranchSnapshots_AuditRunId_DepartmentKey",
                table: "BranchSnapshots",
                columns: new[] { "AuditRunId", "DepartmentKey" });

            migrationBuilder.CreateIndex(
                name: "IX_DepartmentSnapshots_AuditRunId_DepartmentKey",
                table: "DepartmentSnapshots",
                columns: new[] { "AuditRunId", "DepartmentKey" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "BranchSnapshots");

            migrationBuilder.DropTable(
                name: "DepartmentSnapshots");

            migrationBuilder.DropTable(
                name: "AuditRuns");
        }
    }
}
