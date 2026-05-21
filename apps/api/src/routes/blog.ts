// ─────────────────────────────────────────────────────────────
// BLOG ROUTES
// Mount in index.ts via:  app.route("/", blogRoutes)
//
// Endpoints:
//   GET  /api/blogs        — list all published blogs (optional ?tag=)
//   GET  /api/blogs/:id    — single blog by numeric id
//   POST /api/blogs        — create and publish a new blog
// ─────────────────────────────────────────────────────────────

import { Hono }         from "hono"
import { createClient } from "@supabase/supabase-js"

type BlogTag = "technical" | "oss" | "guides" | "general" | "others"

type BlogRow = {
  id:             number
  title:          string
  slug:           string
  content:        string
  excerpt:        string
  coverImage:     string | null
  published:      boolean
  createdAt:      string
  updatedAt:      string
  authorName:     string | null
  authorEmail:    string 
  tags:           string    
  readingTimeMin: number | null
}

type BlogDTO = {
  id:             number
  title:          string
  slug:           string
  excerpt:        string
  coverImage:     string | null
  createdAt:      string
  authorName:     string
  tags:           BlogTag[]
  readingTimeMin: number
  content?:       string
}

type CreateBlogDTO = {
  title:       string
  content:     string
  authorName:  string
  authorEmail: string
  tags:        BlogTag[]
}

type Env = {
  SUPABASE_URL: string
  SUPABASE_KEY: string
}


const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const VALID_TAGS: BlogTag[] = ["technical", "oss", "guides", "general", "others"]

const WPM = 200

function computeReadingTime(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.ceil(words / WPM))
}

function toExcerpt(markdown: string, maxLen = 160): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\(.*?\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\n+/g, " ")
    .trim()
  if (plain.length <= maxLen) return plain
  return plain.slice(0, maxLen).replace(/\s+\S*$/, "") + "…"
}

function toSlug(title: string, id: number): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    + "-" + id
}

function toDTO(row: BlogRow, includeContent = false): BlogDTO {
  const dto: BlogDTO = {
    id:             row.id,
    title:          row.title,
    slug:           row.slug,
    excerpt:        row.excerpt,
    coverImage:     row.coverImage ?? null,
    createdAt:      row.createdAt,
    authorName:     row.authorName ?? "Anonymous",
    tags:           row.tags ? (row.tags.split(",").filter(Boolean) as BlogTag[]) : [],
    readingTimeMin: row.readingTimeMin ?? 1,
  }
  if (includeContent) dto.content = row.content
  return dto
}

const blogRoutes = new Hono<{ Bindings: Env }>()


// ── GET /api/blogs ────────────────────────────────────────────
// Returns all published blogs, newest first.
// Optional: ?tag=technical  → blogs containing that tag
//
// Content is excluded from the list to keep payloads small.
// Response: { success: true, data: BlogDTO[] }

blogRoutes.get("/api/blogs", async (c) => {

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY)

  const tag = c.req.query("tag")

  let query = supabase
    .from("Blog")
    .select("id, title, slug, excerpt, coverImage, published, createdAt, updatedAt, authorName, authorEmail, tags, readingTimeMin")
    .eq("published", true)
    .order("createdAt", { ascending: false })

  if (tag && VALID_TAGS.includes(tag as BlogTag)) {
    query = query.ilike("tags", `%${tag}%`)
  }

  const { data, error } = await query

  if (error) {
    return c.json({ success: false, data: null, error: error.message }, 500)
  }

  return c.json({
    success: true,
    data:    (data as BlogRow[]).map(row => toDTO(row, false)),
    error:   null,
  })

})


// ── GET /api/blogs/:id ────────────────────────────────────────
// Returns a single published blog by its numeric id.
// Includes full content for rendering the detail page.
//
// Response: { success: true, data: BlogDTO }

blogRoutes.get("/api/blogs/:id", async (c) => {

  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY)

  const id = Number(c.req.param("id"))

  if (isNaN(id)) {
    return c.json({ success: false, data: null, error: "Invalid blog id." }, 400)
  }

  const { data, error } = await supabase
    .from("Blog")
    .select("*")
    .eq("id", id)
    .eq("published", true)
    .single()

  if (error || !data) {
    return c.json({ success: false, data: null, error: "Blog not found." }, 404)
  }

  return c.json({
    success: true,
    data:    toDTO(data as BlogRow, true),  // include content
    error:   null,
  })

})


// ── POST /api/blogs ───────────────────────────────────────────
// Creates a new blog, auto-generates excerpt + slug + readingTime,
// and sets published = true immediately.
//
// Request body (JSON):
//   { title, content, authorName, authorEmail, tags: string[] }
//
// Response: { success: true, data: BlogDTO }

blogRoutes.post("/api/blogs", async (c) => {

  let body: CreateBlogDTO
  try {
    body = await c.req.json<CreateBlogDTO>()
  } catch {
    return c.json({ success: false, data: null, error: "Invalid JSON body." }, 400)
  }

  const { title, content, authorName, authorEmail, tags } = body

  if (!title?.trim()) {
    return c.json({ success: false, data: null, error: "Title is required." }, 400)
  }

  if (!content?.trim() || content.trim().length < 30) {
    return c.json({
      success: false,
      data:    null,
      error:   `Content must be at least 30 characters (got ${content?.trim().length ?? 0}).`,
    }, 400)
  }

  if (!authorName?.trim()) {
    return c.json({ success: false, data: null, error: "Author username is required." }, 400)
  }

  if (!authorEmail?.trim() || !EMAIL_REGEX.test(authorEmail)) {
    return c.json({ success: false, data: null, error: "A valid email address is required." }, 400)
  }

  if (!Array.isArray(tags) || tags.length === 0) {
    return c.json({ success: false, data: null, error: "At least one tag is required." }, 400)
  }

  const validatedTags = tags.filter(t => VALID_TAGS.includes(t as BlogTag)) as BlogTag[]
  if (validatedTags.length === 0) {
    return c.json({ success: false, data: null, error: "No valid tags provided." }, 400)
  }

  const supabase      = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY)
  const trimmedTitle  = title.trim()
  const trimmedContent = content.trim()
  const excerpt        = toExcerpt(trimmedContent)
  const readingTimeMin = computeReadingTime(trimmedContent)

  const { data: inserted, error: insertError } = await supabase
    .from("Blog")
    .insert({
      title:          trimmedTitle,
      content:        trimmedContent,
      excerpt,
      authorName:     authorName.trim(),
      authorEmail:    authorEmail.trim().toLowerCase(),
      tags:           validatedTags.join(","),
      readingTimeMin,
      published:      true,
      slug:           `draft-${Date.now()}`,
    })
    .select()
    .single()

  if (insertError || !inserted) {
    return c.json({
      success: false,
      data:    null,
      error:   insertError?.message ?? "Failed to create blog.",
    }, 500)
  }

  const slug = toSlug(trimmedTitle, (inserted as BlogRow).id)

  const { data: updated, error: updateError } = await supabase
    .from("Blog")
    .update({ slug })
    .eq("id", (inserted as BlogRow).id)
    .select()
    .single()

  if (updateError || !updated) {
    return c.json({
      success: true,
      data:    toDTO(inserted as BlogRow, true),
      error:   null,
    }, 201)
  }

  return c.json({
    success: true,
    data:    toDTO(updated as BlogRow, true),
    error:   null,
  }, 201)

})


export default blogRoutes
