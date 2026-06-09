import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const distDir = 'dist'
const secretFileNames = new Set(['.dev.vars', '.env', '.env.local', '.env.production', '.env.development'])

if (!existsSync(distDir)) {
  process.exit(0)
}

for (const filePath of walk(distDir)) {
  const fileName = filePath.split(/[\\/]/).at(-1)
  if (fileName && secretFileNames.has(fileName)) {
    rmSync(filePath, { force: true })
    console.log(`Removed generated local secret file: ${relative(process.cwd(), filePath)}`)
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const filePath = join(dir, entry)
    const stats = statSync(filePath)
    if (stats.isDirectory()) {
      yield* walk(filePath)
    } else {
      yield filePath
    }
  }
}
