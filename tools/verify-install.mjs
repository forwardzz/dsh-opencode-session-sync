#!/usr/bin/env node
// 安装自检：按 DSH 读取 profile 的方式检查本插件是否真的装上、能否被解析。
//
//   node tools/verify-install.mjs            # 检查默认的 desktop profile
//   node tools/verify-install.mjs web        # 检查别的 profile
//
// 只读，不改任何东西。检查项：
//   1. profile package.json 里有 link: 依赖，且 dsh.profile.bundles 里已声明
//   2. profile/node_modules 下的链接指向本目录
//   3. 包内 package.json 的 dsh.bundle.patch 指向存在的 cordis.patch.yml
//   4. patch 文件里确实有把自己插进插件树的 insert 条目
//   5. 从 profile 的解析路径 import 这个包，能拿到 name/inject/apply

import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const packageName = 'dsh-opencode-session-sync'
const profileName = process.argv[2] ?? 'desktop'
const profileDir = join(homedir(), '.dsh', 'profiles', profileName)

const problems = []
const ok = (label) => console.log(`  ✅ ${label}`)
const bad = (label) => {
  problems.push(label)
  console.log(`  ❌ ${label}`)
}

console.log(`profile：${profileDir}`)
if (!existsSync(profileDir)) {
  bad(`profile 目录不存在：${profileDir}`)
} else {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const dependency = manifest.dependencies?.[packageName]
  dependency !== undefined ? ok(`依赖已声明：${dependency}`) : bad('package.json dependencies 里没有本插件')
  const bundles = manifest.dsh?.profile?.bundles ?? []
  bundles.includes(packageName) ? ok('已列入 dsh.profile.bundles') : bad('dsh.profile.bundles 里没有本插件')

  const linkPath = join(profileDir, 'node_modules', packageName)
  if (!existsSync(linkPath)) {
    bad(`node_modules 里没有链接：${linkPath}`)
  } else {
    let target = null
    try {
      target = realpathSync(linkPath)
    } catch (error) {
      bad(`链接无法解析：${String(error?.message ?? error)}`)
    }
    if (target !== null) {
      target === resolve(here) ? ok(`链接指向本目录（${target}）`) : bad(`链接指向别处：${target}`)
    }
    const pkgPath = join(linkPath, 'package.json')
    if (!existsSync(pkgPath)) {
      bad('链接里读不到 package.json')
    } else {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      pkg.name === packageName ? ok(`包名正确：${pkg.name}@${pkg.version}`) : bad(`包名不符：${pkg.name}`)
      const patch = pkg.dsh?.bundle?.patch
      if (typeof patch !== 'string') {
        bad('package.json 缺少 dsh.bundle.patch')
      } else {
        const patchPath = join(linkPath, patch)
        if (!existsSync(patchPath)) bad(`patch 文件不存在：${patch}`)
        else {
          const text = readFileSync(patchPath, 'utf8')
          text.includes('insert:') && text.includes(packageName)
            ? ok(`patch 文件包含 insert 条目：${patch}`)
            : bad(`patch 文件里没有 insert ${packageName} 的条目`)
        }
      }
      const entry = join(linkPath, pkg.main ?? 'lib/index.js')
      if (!existsSync(entry)) bad(`入口不存在：${entry}`)
      else {
        const module = await import(pathToFileURL(entry).href)
        typeof module.default?.apply === 'function' ? ok('入口可加载且导出 apply()') : bad('入口没有导出 apply()')
        Array.isArray(module.inject) ? ok(`inject：${module.inject.join(', ')}`) : bad('没有导出 inject')
        assert.equal(typeof module.default?.name, 'string')
      }
    }
  }
}

if (problems.length === 0) {
  console.log('安装自检通过 ✅（重启 DeepSeek Harness 后插件才会生效）')
} else {
  console.log(`安装自检发现 ${problems.length} 个问题 ❌`)
  process.exitCode = 1
}
