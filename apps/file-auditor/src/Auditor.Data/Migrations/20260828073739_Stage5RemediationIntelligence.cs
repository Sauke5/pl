using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Auditor.Data.Migrations
{
    /// <inheritdoc />
    public partial class Stage5RemediationIntelligence : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ProblemLengthHistogramJson",
                table: "BranchSnapshots",
                type: "TEXT",
                nullable: false,
                defaultValue: "");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ProblemLengthHistogramJson",
                table: "BranchSnapshots");
        }
    }
}
