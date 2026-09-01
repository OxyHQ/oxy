import { useRef, useState } from "react"
import { useAuth, useCurrentUser, useUpdateProfile, useUploadAvatar, useUserByUsername } from "@oxyhq/services"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { toast } from "@oxyhq/bloom"

export function ProfileDemo() {
  const { isAuthenticated, oxyServices } = useAuth()
  const { data: currentUser, isLoading } = useCurrentUser()
  const updateProfile = useUpdateProfile()
  const uploadAvatar = useUploadAvatar()

  const [username, setUsername] = useState("")
  const [bio, setBio] = useState("")
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [lookupInput, setLookupInput] = useState("")
  const [lookupUsername, setLookupUsername] = useState("")

  const { data: lookedUpUser, isLoading: lookupLoading } = useUserByUsername(lookupUsername || "")

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Sign in to view and edit your profile.
          </CardContent>
        </Card>
      </div>
    )
  }

  const handleUpdateProfile = async () => {
    try {
      await updateProfile.mutateAsync({
        username: username || undefined,
        bio: bio || undefined,
      })
      toast.success("Profile updated")
    } catch (err) {
      toast.error("Failed to update profile: " + String(err))
    }
  }

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const preview = URL.createObjectURL(file)
    setAvatarPreview(preview)
    try {
      await uploadAvatar.mutateAsync({
        uri: preview,
        name: file.name,
        type: file.type,
        size: file.size,
      })
      toast.success("Avatar uploaded")
    } catch (err) {
      toast.error("Failed to upload avatar: " + String(err))
      setAvatarPreview(null)
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Current User Profile */}
      <Card>
        <CardHeader>
          <CardTitle>Current User</CardTitle>
          <CardDescription>Your profile from useCurrentUser()</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-4">
              <Skeleton className="size-16 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ) : currentUser ? (
            <div className="flex items-center gap-4">
              <Avatar className="size-16">
                <AvatarImage src={currentUser?.avatar && oxyServices ? oxyServices.getFileDownloadUrl(currentUser.avatar, 'thumb') : undefined} alt={currentUser.username} />
                <AvatarFallback className="text-lg">{(currentUser.username || "U")[0].toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-lg font-medium">{currentUser.username}</p>
                <p className="text-sm text-muted-foreground">{currentUser.email}</p>
                {currentUser.bio && (
                  <p className="mt-1 text-sm">{currentUser.bio}</p>
                )}
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">No user data</p>
          )}
        </CardContent>
      </Card>

      {/* Edit Profile */}
      <Card>
        <CardHeader>
          <CardTitle>Edit Profile</CardTitle>
          <CardDescription>Update via useUpdateProfile()</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              placeholder={currentUser?.username || "Enter username"}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              placeholder="Tell us about yourself"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
          </div>
          <Button
            onClick={handleUpdateProfile}
            disabled={updateProfile.isPending || (!username && !bio)}
          >
            {updateProfile.isPending ? "Updating..." : "Update Profile"}
          </Button>
        </CardContent>
      </Card>

      {/* Avatar Upload */}
      <Card>
        <CardHeader>
          <CardTitle>Avatar Upload</CardTitle>
          <CardDescription>Upload via useUploadAvatar()</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadAvatar.isPending}
              className="group relative shrink-0"
            >
              <Avatar className="size-20">
                <AvatarImage
                  src={avatarPreview || (currentUser?.avatar && oxyServices ? oxyServices.getFileDownloadUrl(currentUser.avatar, 'thumb') : undefined)}
                  alt="Avatar"
                />
                <AvatarFallback className="text-2xl">
                  {(currentUser?.username || "U")[0].toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="text-xs font-medium text-white">Change</span>
              </div>
              {uploadAvatar.isPending && (
                <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40">
                  <div className="size-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                </div>
              )}
            </button>
            <div className="space-y-1">
              <p className="text-sm font-medium">Profile picture</p>
              <p className="text-xs text-muted-foreground">Click the avatar to upload a new image</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadAvatar.isPending}
              >
                {uploadAvatar.isPending ? "Uploading..." : "Choose file"}
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarUpload}
              className="hidden"
            />
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* User Lookup */}
      <Card>
        <CardHeader>
          <CardTitle>User Lookup</CardTitle>
          <CardDescription>Search by username via useUserByUsername()</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Enter a username to look up"
              value={lookupInput}
              onChange={(e) => setLookupInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setLookupUsername(lookupInput.trim())}
            />
            <Button
              variant="outline"
              onClick={() => setLookupUsername(lookupInput.trim())}
              disabled={!lookupInput.trim()}
            >
              Lookup
            </Button>
          </div>
          {lookupLoading && lookupUsername && (
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
          )}
          {lookedUpUser && !lookupLoading && (
            <div className="flex items-center gap-3 rounded-md border p-3">
              <Avatar>
                <AvatarImage src={lookedUpUser.avatar && oxyServices ? oxyServices.getFileDownloadUrl(lookedUpUser.avatar, 'thumb') : undefined} />
                <AvatarFallback>{(lookedUpUser.username || "?")[0].toUpperCase()}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium">{lookedUpUser.username}</p>
                <p className="text-sm text-muted-foreground">{lookedUpUser.email}</p>
              </div>
            </div>
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
{`import { useCurrentUser, useUpdateProfile, useUploadAvatar } from '@oxyhq/services';

function Profile() {
  const { data: user } = useCurrentUser();
  const updateProfile = useUpdateProfile();
  const uploadAvatar = useUploadAvatar();

  await updateProfile.mutateAsync({ username: 'new-name' });
  await uploadAvatar.mutateAsync(file);
}`}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
