using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Auditor.Data.Migrations
{
    /// <inheritdoc />
    public partial class Stage4_1ReportPolish : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "DfsPath",
                table: "PathSampleSnapshots",
                type: "TEXT",
                maxLength: 4000,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "UncPath",
                table: "PathSampleSnapshots",
                type: "TEXT",
                maxLength: 4000,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DfsPath",
                table: "PathSampleSnapshots");

            migrationBuilder.DropColumn(
                name: "UncPath",
                table: "PathSampleSnapshots");
        }
    }
}
