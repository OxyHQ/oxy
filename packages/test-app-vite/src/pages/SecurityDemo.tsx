import { useAuth, useSecurityActivity, usePrivacySettings, useUpdatePrivacySettings } from "@oxyhq/services"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "@oxyhq/bloom"

export function SecurityDemo() {
  const { isAuthenticated } = useAuth()
  const { data: activity, isLoading: activityLoading } = useSecurityActivity()
  const { data: privacy, isLoading: privacyLoading } = usePrivacySettings()
  const updatePrivacy = useUpdatePrivacySettings()

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Sign in to view security settings.
          </CardContent>
        </Card>
      </div>
    )
  }

  const handleToggle = async (key: string, value: boolean) => {
    try {
      await updatePrivacy.mutateAsync({ settings: { [key]: value } })
      toast.success("Privacy setting updated")
    } catch (err) {
      toast.error("Failed to update: " + String(err))
    }
  }

  const activityItems = activity?.data ?? []

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Security Activity */}
      <Card>
        <CardHeader>
          <CardTitle>Security Activity</CardTitle>
          <CardDescription>Recent events via useSecurityActivity()</CardDescription>
        </CardHeader>
        <CardContent>
          {activityLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : activityItems.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Severity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activityItems.slice(0, 10).map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="font-medium text-sm">
                      {event.eventType}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {event.eventDescription || "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {event.createdAt
                        ? new Date(event.createdAt).toLocaleString()
                        : event.timestamp
                          ? new Date(event.timestamp).toLocaleString()
                          : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={event.severity === "critical" || event.severity === "high" ? "destructive" : "default"}>
                        {event.severity}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No security events found</p>
          )}
        </CardContent>
      </Card>

      {/* Privacy Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Privacy Settings</CardTitle>
          <CardDescription>Manage via usePrivacySettings() + useUpdatePrivacySettings()</CardDescription>
        </CardHeader>
        <CardContent>
          {privacyLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : privacy ? (
            <div className="space-y-4">
              {Object.entries(privacy)
                .filter(([, value]) => typeof value === "boolean")
                .map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between">
                    <Label htmlFor={key} className="cursor-pointer">
                      {key
                        .replace(/([A-Z])/g, " $1")
                        .replace(/^./, (s) => s.toUpperCase())
                        .trim()}
                    </Label>
                    <Switch
                      id={key}
                      checked={Boolean(value)}
                      onCheckedChange={(checked) => handleToggle(key, checked)}
                      disabled={updatePrivacy.isPending}
                    />
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No privacy settings available</p>
          )}
        </CardContent>
      </Card>

      {/* Code Example */}
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">
{`import { useSecurityActivity, usePrivacySettings, useUpdatePrivacySettings } from '@oxyhq/services';

function Security() {
  const { data: activity } = useSecurityActivity();
  const { data: privacy } = usePrivacySettings();
  const updatePrivacy = useUpdatePrivacySettings();

  await updatePrivacy.mutateAsync({ profileVisible: false });
}`}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
