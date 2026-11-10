import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'public/downloads/puls-seti-source.zip')
// An explicit allowlist excludes credentials, build caches and generated archives.
const included = [
  'package.json', 'package-lock.json', 'vite.config.js', 'index.html',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'eslint.config.js',
  '.gitignore', '.vercelignore', 'README.md', 'PROJECT.md', 'vercel.json',
  'src', 'public/favicon.svg', 'public/LICENSE-source.txt', 'public/data',
  'scripts/package-source.mjs', 'scripts/qa.mjs',
]
const files = []
// Hosting uploaders may omit their own ignore files; these defaults are complete.
const optionalFiles = new Map([
  ['.gitignore', 'node_modules/\ndist/\ndist-ssr/\nartifacts/\npublic/downloads/\n.env\n.env.*\n*.local\n*.log\n.vite-source-tags.js\n'],
  ['.vercelignore', 'artifacts/\npublic/downloads/\n'],
])

async function collect(relativePath) {
  const absolutePath = resolve(root, relativePath)
  const info = await lstat(absolutePath).catch(error => {
    if (error.code === 'ENOENT' && optionalFiles.has(relativePath)) return null
    throw error
  })
  if (!info) {
    files.push({ name: `puls-seti/${relativePath}`, data: Buffer.from(optionalFiles.get(relativePath)) })
    return
  }
  if (info.isSymbolicLink()) throw new Error(`Symbolic links are not exported: ${relativePath}`)
  if (info.isDirectory()) {
    for (const name of (await readdir(absolutePath)).sort()) {
      await collect(`${relativePath}/${name}`)
    }
    return
  }
  if (!info.isFile()) throw new Error(`Unsupported source file: ${relativePath}`)
  let data = await readFile(absolutePath)
  if (relativePath === 'index.html') {
    const clean = data.toString('utf8')
      .replace(/<script\b[^>]*\bdata-(?:arena-(?:recording|views)|element-picker)[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/\n(?:[\t ]*\n)+/g, '\n')
    data = Buffer.from(clean)
  }
  files.push({ name: `puls-seti/${relativePath}`, data })
}

for (const item of included) await collect(item)
files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
if (files.length > 65535) throw new Error('Too many source files for the ZIP format')

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const localParts = []
const centralParts = []
let offset = 0
for (const file of files) {
  const name = Buffer.from(file.name, 'utf8')
  const compressed = deflateRawSync(file.data, { level: 9 })
  const crc = crc32(file.data)
  if (name.length > 65535 || file.data.length > 0xffffffff || compressed.length > 0xffffffff) {
    throw new Error(`Source file exceeds ZIP limits: ${file.name}`)
  }
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x800, 6)
  local.writeUInt16LE(8, 8)
  local.writeUInt16LE(0x21, 12) // Stable DOS date for reproducible archives.
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(file.data.length, 22)
  local.writeUInt16LE(name.length, 26)
  localParts.push(local, name, compressed)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt16LE(0x21, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(file.data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(offset, 42)
  centralParts.push(central, name)
  offset += local.length + name.length + compressed.length
  if (offset > 0xffffffff) throw new Error('Source archive exceeds ZIP limits')
}

const centralDirectory = Buffer.concat(centralParts)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(files.length, 8)
end.writeUInt16LE(files.length, 10)
end.writeUInt32LE(centralDirectory.length, 12)
end.writeUInt32LE(offset, 16)
const archive = Buffer.concat([...localParts, centralDirectory, end])
await mkdir(dirname(output), { recursive: true })
await writeFile(output, archive)
console.log(`Source archive: public/downloads/puls-seti-source.zip (${files.length} files, ${Math.ceil(archive.length / 1024)} KiB)`)
