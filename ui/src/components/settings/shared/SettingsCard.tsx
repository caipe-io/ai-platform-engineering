import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

interface SettingsCardProps {
  children: React.ReactNode;
  className?: string;
  collapsibleLabel?: string;
  description?: React.ReactNode;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  title: React.ReactNode;
}

export function SettingsCard({
  children,
  className,
  collapsibleLabel,
  description,
  expanded = true,
  onExpandedChange,
  title,
}: SettingsCardProps): React.ReactElement {
  const collapsible = Boolean(collapsibleLabel && onExpandedChange);

  return (
    <Card className={cn("overflow-hidden",className)}>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <CardTitle className="text-lg">{title}</CardTitle>
            {description ? <CardDescription className="mt-1.5">{description}</CardDescription> : null}
          </div>
          {collapsible ? (
            <Button
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${collapsibleLabel}`}
              className="-mr-2 -mt-2 shrink-0"
              onClick={() => onExpandedChange?.(!expanded)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronDown className={cn("h-4 w-4 transition-transform",expanded && "rotate-180")} />
            </Button>
          ) : null}
        </div>
      </CardHeader>
      {!collapsible || expanded ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}
