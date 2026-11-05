using Auditor.Data.Entities;
using Microsoft.EntityFrameworkCore;

namespace Auditor.Data;

public sealed class AuditorDbContext : DbContext
{
    public AuditorDbContext(
        DbContextOptions<AuditorDbContext> options)
        : base(options)
    {
    }

    public DbSet<AuditRun> AuditRuns =>
        Set<AuditRun>();

    public DbSet<DepartmentSnapshot> DepartmentSnapshots =>
        Set<DepartmentSnapshot>();

    public DbSet<BranchSnapshot> BranchSnapshots =>
        Set<BranchSnapshot>();

    public DbSet<PathSampleSnapshot> PathSampleSnapshots =>
        Set<PathSampleSnapshot>();

    public DbSet<ScanRootSelection> ScanRootSelections =>
        Set<ScanRootSelection>();

    public DbSet<ScanThresholdSnapshot> ScanThresholdSnapshots =>
        Set<ScanThresholdSnapshot>();

    protected override void OnModelCreating(
        ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.Entity<AuditRun>(
            entity =>
            {
                entity.HasKey(x => x.Id);

                entity.Property(x => x.Status)
                    .HasMaxLength(32);

                entity.Property(x => x.Failure)
                    .HasMaxLength(4000);

                entity.HasIndex(x => x.StartedAtUtc);

                entity.HasIndex(
                    x => new
                    {
                        x.Status,
                        x.StartedAtUtc
                    });
            });

        modelBuilder.Entity<ScanRootSelection>(entity =>
        {
            entity.HasKey(x => new { x.AuditRunId, x.RootName });
            entity.Property(x => x.RootName).HasMaxLength(100);
            entity.HasOne(x => x.AuditRun)
                .WithMany(x => x.SelectedRoots)
                .HasForeignKey(x => x.AuditRunId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<ScanThresholdSnapshot>(entity =>
        {
            entity.HasKey(x => x.AuditRunId);
            entity.HasOne(x => x.AuditRun)
                .WithOne(x => x.Thresholds)
                .HasForeignKey<ScanThresholdSnapshot>(x => x.AuditRunId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<DepartmentSnapshot>(
            entity =>
            {
                entity.HasKey(x => x.Id);

                entity.Property(x => x.RootLabel)
                    .HasMaxLength(100);

                entity.Property(x => x.DepartmentKey)
                    .HasMaxLength(500);

                entity.Property(x => x.DepartmentName)
                    .HasMaxLength(500);

                entity.Property(x => x.MaxPathRelative)
                    .HasMaxLength(4000);

                entity.HasIndex(
                    x => new
                    {
                        x.AuditRunId,
                        x.DepartmentKey
                    });

                entity
                    .HasOne(x => x.AuditRun)
                    .WithMany(x => x.Departments)
                    .HasForeignKey(x => x.AuditRunId)
                    .OnDelete(DeleteBehavior.Cascade);
            });

        modelBuilder.Entity<BranchSnapshot>(
            entity =>
            {
                entity.HasKey(x => x.Id);

                entity.Property(x => x.RootLabel)
                    .HasMaxLength(100);

                entity.Property(x => x.DepartmentKey)
                    .HasMaxLength(500);

                entity.Property(x => x.DepartmentName)
                    .HasMaxLength(500);

                entity.Property(x => x.RelativePath)
                    .HasMaxLength(4000);

                entity.HasIndex(
                    x => new
                    {
                        x.AuditRunId,
                        x.DepartmentKey,
                        x.CriticalPaths
                    });

                entity
                    .HasOne(x => x.AuditRun)
                    .WithMany(x => x.Branches)
                    .HasForeignKey(x => x.AuditRunId)
                    .OnDelete(DeleteBehavior.Cascade);
            });
        modelBuilder.Entity<PathSampleSnapshot>(
            entity =>
            {
                entity.HasKey(x => x.Id);

                entity.Property(x => x.RootLabel)
                    .HasMaxLength(100);

                entity.Property(x => x.DepartmentKey)
                    .HasMaxLength(500);

                entity.Property(x => x.DepartmentName)
                    .HasMaxLength(500);

                entity.Property(x => x.SampleKind)
                    .HasMaxLength(32);

                entity.Property(x => x.RelativePath)
                    .HasMaxLength(4000);

                entity.Property(x => x.DfsPath)
                    .HasMaxLength(4000);

                entity.Property(x => x.UncPath)
                    .HasMaxLength(4000);

                entity.Property(x => x.Name)
                    .HasMaxLength(1024);

                entity.Property(x => x.Severity)
                    .HasMaxLength(32);

                entity.Property(x => x.Cause)
                    .HasMaxLength(64);

                entity.HasIndex(
                    x => new
                    {
                        x.AuditRunId,
                        x.DepartmentKey,
                        x.SampleKind
                    });

                entity
                    .HasOne(x => x.AuditRun)
                    .WithMany(x => x.Samples)
                    .HasForeignKey(x => x.AuditRunId)
                    .OnDelete(DeleteBehavior.Cascade);
            });
    }
}
