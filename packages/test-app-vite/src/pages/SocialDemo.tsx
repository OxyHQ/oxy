import { useState } from "react"
import { useAuth, useFollow, useFollowerCounts, useUserByUsername } from "@oxy.so/services"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"

export function SocialDemo() {
  const { isAuthenticated, oxyServices } = useAuth()
  const [searchUsername, setSearchUsername] = useState("")
  const [targetUsername, setTargetUsername] = useState("")

  const { data: foundUser, isLoading: searching } = useUserByUsername(targetUsername || "")
  const targetUserId = foundUser?.id || ""

  const follow = useFollow(targetUserId || undefined)
  const counts = useFollowerCounts(targetUserId)

  const handleSearch = () => {
    setTargetUsername(searchUsername.trim())
  }

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Sign in to explore social features.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* User Search */}
      <Card>
        <CardHeader>
          <CardTitle>Find User</CardTitle>
          <CardDescription>Search by username via useUserByUsername()</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Enter username..."
              value={searchUsername}
              onChange={(e) => setSearchUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
            <Button onClick={handleSearch} disabled={!searchUsername.trim()}>
              Search
            </Button>
          </div>

          {searching && targetUsername && (
            <div className="flex items-center gap-3">
              <Skeleton className="size-12 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          )}

          {foundUser && !searching && (
            <div className="rounded-lg border p-4">
              <div className="flex items-center gap-4">
                <Avatar className="size-12">
                  <AvatarImage src={foundUser.avatar && oxyServices ? oxyServices.getFileDownloadUrl(foundUser.avatar, 'thumb') : undefined} />
                  <AvatarFallback>
                    {(foundUser.username || "?")[0].toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <p className="font-medium">{foundUser.username}</p>
                  <p className="text-sm text-muted-foreground">{foundUser.email}</p>
                  {foundUser.bio && (
                    <p className="mt-1 text-sm">{foundUser.bio}</p>
                  )}
                </div>
                {targetUserId && (
                  <Button
                    variant={follow.isFollowing ? "outline" : "default"}
                    onClick={follow.toggleFollow}
                    disabled={follow.isLoading}
                  >
                    {follow.isLoading
                      ? "..."
                      : follow.isFollowing
                        ? "Unfollow"
                        : "Follow"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {targetUsername && !foundUser && !searching && (
            <p className="text-sm text-muted-foreground">No user found with username "{targetUsername}"</p>
          )}
        </CardContent>
      </Card>

      {/* Follower Counts */}
      {targetUserId && (
        <Card>
          <CardHeader>
            <CardTitle>Follower Counts</CardTitle>
            <CardDescription>Stats from useFollowerCounts()</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-md border p-4 text-center">
                <p className="text-2xl font-bold">
                  {counts.isLoadingCounts ? "..." : counts.followerCount}
                </p>
                <p className="text-sm text-muted-foreground">Followers</p>
              </div>
              <div className="rounded-md border p-4 text-center">
                <p className="text-2xl font-bold">
                  {counts.isLoadingCounts ? "..." : counts.followingCount}
                </p>
                <p className="text-sm text-muted-foreground">Following</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Code Example */}
      <Card>
        <CardHeader>
          <CardTitle>Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-auto rounded-md bg-muted p-4 text-xs">
{`import { useFollow, useFollowerCounts, useUserByUsername } from '@oxy.so/services';

function Social() {
  const { data: user } = useUserByUsername('john');
  const follow = useFollow(user.id);
  const counts = useFollowerCounts(user.id);

  follow.toggleFollow();
  console.log(counts.followerCount, counts.followingCount);
}`}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
