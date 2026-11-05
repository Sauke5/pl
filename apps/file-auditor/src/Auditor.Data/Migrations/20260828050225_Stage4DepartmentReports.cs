using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Auditor.Data.Migrations
{
    /// <inheritdoc />
    public partial class Stage4DepartmentReports : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "PathSampleSnapshots",
                columns: table => new
                {
                    Id = table.Column<long>(type: "INTEGER", nullable: false)
                        .Annotation("Sqlite:Autoincrement", true),
                    AuditRunId = table.Column<long>(type: "INTEGER", nullable: false),
                    RootLabel = table.Column<string>(type: "TEXT", maxLength: 100, nullable: false),
                    DepartmentKey = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    DepartmentName = table.Column<string>(type: "TEXT", maxLength: 500, nullable: false),
                    SampleKind = table.Column<string>(type: "TEXT", maxLength: 32, nullable: false),
                    RelativePath = table.Column<string>(type: "TEXT", maxLength: 4000, nullable: false),
                    Name = table.Column<string>(type: "TEXT", maxLength: 1024, nullable: true),
                    Severity = table.Column<string>(type: "TEXT", maxLength: 32, nullable: true),
                    Cause = table.Column<string>(type: "TEXT", maxLength: 64, nullable: true),
                    PathLength = table.Column<int>(type: "INTEGER", nullable: false),
                    Depth = table.Column<int>(type: "INTEGER", nullable: false),
                    NameLength = table.Column<int>(type: "INTEGER", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PathSampleSnapshots", x => x.Id);
                    table.ForeignKey(
                        name: "FK_PathSampleSnapshots_AuditRuns_AuditRunId",
                        column: x => x.AuditRunId,
                        principalTable: "AuditRuns",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_PathSampleSnapshots_AuditRunId_DepartmentKey_SampleKind",
                table: "PathSampleSnapshots",
                columns: new[] { "AuditRunId", "DepartmentKey", "SampleKind" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PathSampleSnapshots");
        }
    }
}
