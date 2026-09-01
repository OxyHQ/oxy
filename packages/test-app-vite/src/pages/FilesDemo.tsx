import { useState, useCallback } from "react"
import { useAuth, useAssets, useFileFiltering, useFileDownloadUrl, setOxyAssetInstance, type ViewMode, type SortBy } from "@oxyhq/services"
import type { FileMetadata } from "@oxyhq/core"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@oxyhq/bloom"

const VIEW_MODES: ViewMode[] = ["all", "photos", "videos", "documents", "audio"]
const SORT_BYS: SortBy[] = ["date", "name", "size", "type"]

function isViewMode(value: string): value is ViewMode {
  return (VIEW_MODES as string[]).includes(value)
}

function isSortBy(value: string): value is SortBy {
  return (SORT_BYS as string[]).includes(value)
}

function FileDownloadDemo({ fileId }: { fileId: string }) {
  const { oxyServices } = useAuth()
  const { url, loading, error } = useFileDownloadUrl(oxyServices, fileId)
  return (
    <span className="text-xs">
      {loading ? "Resolving..." : error ? "Error" : url ? <a href={url} className="text-primary underline" target="_blank" rel="noreferrer">Download</a> : "—"}
    </span>
  )
}

export function FilesDemo() {
  const { isAuthenticated, oxyServices } = useAuth()
  const assets = useAssets()
  const [uploadFile, setUploadFile] = useState<File | null>(null)

  // The store-backed asset hooks read their OxyServices instance from a module
  // singleton; register it once the provider has one.
  if (oxyServices) {
    setOxyAssetInstance(oxyServices)
  }

  // `useAssets()` returns the new Asset[] shape; `useFileFiltering` operates on
  // GridFS FileMetadata[]. Bridge the two so the browser demo can filter/sort.
  const files: FileMetadata[] = assets.assets.map((asset) => ({
    id: asset.id,
    filename: asset.originalName ?? asset.id,
    contentType: asset.mime,
    length: asset.size,
    chunkSize: 0,
    uploadDate: asset.createdAt,
  }))

  const {
    filteredFiles,
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    sortBy,
    setSortBy,
    sortOrder,
    toggleSortOrder,
  } = useFileFiltering({ files })

  const handleUpload = useCallback(async () => {
    if (!uploadFile) return
    try {
      await assets.upload(uploadFile)
      toast.success("File uploaded")
      setUploadFile(null)
    } catch (err) {
      toast.error("Upload failed: " + String(err))
    }
  }, [uploadFile, assets])

  if (!isAuthenticated) {
    return (
      <div className="mx-auto max-w-3xl">
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Sign in to manage files and assets.
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* File Upload */}
      <Card>
        <CardHeader>
          <CardTitle>File Upload</CardTitle>
          <CardDescription>Upload files via useAssets()</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-2">
              <Label>Select File</Label>
              <Input
                type="file"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              />
            </div>
            <Button onClick={handleUpload} disabled={!uploadFile}>
              Upload
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* File Filtering */}
      <Card>
        <CardHeader>
          <CardTitle>File Browser</CardTitle>
          <CardDescription>Filter and sort via useFileFiltering()</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="max-w-xs"
            />
            <Select value={viewMode} onValueChange={(v) => { if (isViewMode(v)) setViewMode(v) }}>
              <SelectTrigger className="w-36">
                <SelectValue placeholder="View mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Files</SelectItem>
                <SelectItem value="photos">Photos</SelectItem>
                <SelectItem value="videos">Videos</SelectItem>
                <SelectItem value="documents">Documents</SelectItem>
                <SelectItem value="audio">Audio</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(v) => { if (isSortBy(v)) setSortBy(v) }}>
              <SelectTrigger className="w-32">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Date</SelectItem>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="size">Size</SelectItem>
                <SelectItem value="type">Type</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={toggleSortOrder}>
              {sortOrder === "asc" ? "Asc" : "Desc"}
            </Button>
          </div>

          {filteredFiles.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Download</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredFiles.map((file) => (
                  <TableRow key={file.id}>
                    <TableCell className="font-medium text-sm">{file.filename || "Untitled"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{file.contentType || "unknown"}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {file.length ? `${(file.length / 1024).toFixed(1)} KB` : "—"}
                    </TableCell>
                    <TableCell>
                      <FileDownloadDemo fileId={file.id} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No files found. Upload some files to see them here.</p>
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
{`import { useAssets, useFileFiltering, useFileDownloadUrl } from '@oxyhq/services';

function Files() {
  const assets = useAssets();
  const { filteredFiles, setViewMode, setSearchQuery } = useFileFiltering({ files });
  const { url } = useFileDownloadUrl(oxyServices, fileId);

  await assets.upload(file);
}`}
          </pre>
        </CardContent>
      </Card>
    </div>
  )
}
