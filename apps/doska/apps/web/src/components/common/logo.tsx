import { appPath } from "@/lib/app-path";
import { Link } from "@tanstack/react-router";
import useProjectStore from "@/store/project";

type LogoProps = {
  className?: string;
};

export function Logo({ className = "" }: LogoProps) {
  const { setProject } = useProjectStore();

  return (
    <Link
      onClick={() => {
        setProject(undefined);
      }}
      to="/dashboard"
      className={`w-auto ${className}`}
    >
      <img
        src={appPath("/logo-dark.svg")}
        alt="Kaneo"
        className="h-6 w-auto dark:hidden"
      />
      <img
        src={appPath("/logo-light.svg")}
        alt="Kaneo"
        className="hidden h-6 w-auto dark:block"
      />
    </Link>
  );
}
