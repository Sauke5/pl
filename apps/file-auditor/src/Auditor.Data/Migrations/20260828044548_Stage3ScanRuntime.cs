using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Auditor.Data.Migrations
{
    /// <inheritdoc />
    public partial class Stage3ScanRuntime : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_BranchSnapshots_AuditRunId_DepartmentKey",
                table: "BranchSnapshots");

            migrationBuilder.AddColumn<string>(
                name: "MaxPathRelative",
                table: "DepartmentSnapshots",
                type: "TEXT",
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "RootLabel",
                table: "DepartmentSnapshots",
                type: "TEXT",
                maxLength: 100,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<long>(
                name: "TotalDirectories",
                table: "DepartmentSnapshots",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "TotalFiles",
                table: "DepartmentSnapshots",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "DeepPaths",
                table: "BranchSnapshots",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "DepartmentName",
                table: "BranchSnapshots",
                type: "TEXT",
                maxLength: 500,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<long>(
                name: "LongNames",
                table: "BranchSnapshots",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "RootLabel",
                table: "BranchSnapshots",
                type: "TEXT",
                maxLength: 100,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<long>(
                name: "ErrorCount",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "ExcessiveDepth",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<string>(
                name: "Failure",
                table: "AuditRuns",
                type: "TEXT",
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "LongNames",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<int>(
                name: "MaxDepth",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<long>(
                name: "ObjectsPerSecond",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<int>(
                name: "PeakActiveWorkers",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<string>(
                name: "Status",
                table: "AuditRuns",
                type: "TEXT",
                maxLength: 32,
                nullable: false,
                defaultValue: "");

            migrationBuilder.AddColumn<long>(
                name: "TotalDirectories",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<long>(
                name: "TotalFiles",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0L);

            migrationBuilder.AddColumn<int>(
                name: "Workers",
                table: "AuditRuns",
                type: "INTEGER",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateIndex(
                name: "IX_BranchSnapshots_AuditRunId_DepartmentKey_CriticalPaths",
                table: "BranchSnapshots",
                columns: new[] { "AuditRunId", "DepartmentKey", "CriticalPaths" });

            migrationBuilder.CreateIndex(
                name: "IX_AuditRuns_Status_StartedAtUtc",
                table: "AuditRuns",
                columns: new[] { "Status", "StartedAtUtc" });

            migrationBuilder.AddForeignKey(
                name: "FK_BranchSnapshots_AuditRuns_AuditRunId",
                table: "BranchSnapshots",
                column: "AuditRunId",
                principalTable: "AuditRuns",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_BranchSnapshots_AuditRuns_AuditRunId",
                table: "BranchSnapshots");

            migrationBuilder.DropIndex(
                name: "IX_BranchSnapshots_AuditRunId_DepartmentKey_CriticalPaths",
                table: "BranchSnapshots");

            migrationBuilder.DropIndex(
                name: "IX_AuditRuns_Status_StartedAtUtc",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "MaxPathRelative",
                table: "DepartmentSnapshots");

            migrationBuilder.DropColumn(
                name: "RootLabel",
                table: "DepartmentSnapshots");

            migrationBuilder.DropColumn(
                name: "TotalDirectories",
                table: "DepartmentSnapshots");

            migrationBuilder.DropColumn(
                name: "TotalFiles",
                table: "DepartmentSnapshots");

            migrationBuilder.DropColumn(
                name: "DeepPaths",
                table: "BranchSnapshots");

            migrationBuilder.DropColumn(
                name: "DepartmentName",
                table: "BranchSnapshots");

            migrationBuilder.DropColumn(
                name: "LongNames",
                table: "BranchSnapshots");

            migrationBuilder.DropColumn(
                name: "RootLabel",
                table: "BranchSnapshots");

            migrationBuilder.DropColumn(
                name: "ErrorCount",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "ExcessiveDepth",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "Failure",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "LongNames",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "MaxDepth",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "ObjectsPerSecond",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "PeakActiveWorkers",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "Status",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "TotalDirectories",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "TotalFiles",
                table: "AuditRuns");

            migrationBuilder.DropColumn(
                name: "Workers",
                table: "AuditRuns");

            migrationBuilder.CreateIndex(
                name: "IX_BranchSnapshots_AuditRunId_DepartmentKey",
                table: "BranchSnapshots",
                columns: new[] { "AuditRunId", "DepartmentKey" });
        }
    }
}
