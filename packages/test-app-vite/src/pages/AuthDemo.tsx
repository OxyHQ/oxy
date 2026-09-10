import { useAuth } from "@oxy.so/services"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export function AuthDemo() {
  const {
    user,
    isAuthenticated,
    isLoading,
    isReady,
    canUsePrivateApi,
    error,
    signIn,
    signOut,
    oxyServices,
  } = useAuth()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Auth Status */}
      <Card>
        <CardHeader>
          <CardTitle>Auth Status</CardTitle>
          <CardDescription>Current authentication state from useAuth()</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-muted-foreground">Loading...</p>
          ) : isAuthenticated && user ? (
            <div className="flex items-center gap-4">
              <Avatar className="size-12">
                <AvatarImage src={user.avatar && oxyServices ? oxyServices.getFileDownloadUrl(user.avatar, 'thumb') : undefined} alt={user.username} />
                <AvatarFallback>{(user.username || "U")[0].toUpperCase()}</AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <p className="font-medium">{user.username || user.email}</p>
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>
              <Badge variant="default">Authenticated</Badge>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground">Not signed in</p>
              <Badge variant="secondary">Unauthenticated</Badge>
            </div>
          )}
          {error && (
            <p className="mt-2 text-sm text-destructive">{String(error)}</p>
          )}
        </CardContent>
      </Card>

      {/* Sign In */}
      <Card>
        <CardHeader>
          <CardTitle>Sign In</CardTitle>
          <CardDescription>
            Interactive sign-in opens the in-app Oxy account dialog (device-first, no redirect).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isAuthenticated ? (
            <Button variant="destructive" onClick={() => void signOut()} className="w-full">
              Sign Out
            </Button>
          ) : (
            <Button onClick={() => void signIn()} className="w-full">
              Sign in with Oxy
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Raw State */}
      <Card>
        <CardHeader>
          <CardTitle>Raw Auth State</CardTitle>
          <CardDescription>JSON representation of useAuth() return value</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="state">
            <TabsList>
              <TabsTrigger value="state">State</TabsTrigger>
              <TabsTrigger value="user">User</TabsTrigger>
            </TabsList>
            <TabsContent value="state">
              <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">
                {JSON.stringify(
                  { isAuthenticated, isLoading, isReady, canUsePrivateApi, error: error ? String(error) : null },
                  null,
                  2
                )}
              </pre>
            </TabsContent>
            <TabsContent value="user">
              <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">
                {JSON.stringify(user, null, 2)}
              </pre>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Code Example */}
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">
{`import { useAuth } from '@oxy.so/services';

function MyComponent() {
  const { user, isAuthenticated, signIn, signOut } = useAuth();

  if (!isAuthenticated) {
    return <button onClick={() => signIn()}>Sign In</button>;
  }

  return <p>Hello, {user.username}</p>;
}`}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
