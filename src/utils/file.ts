import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import Buffer from 'buffer-from'
import COS from 'cos-js-sdk-v5'
import CryptoJS from 'crypto-js'
import * as Minio from 'minio'
import * as qiniu from 'qiniu-js'
import OSS from 'tiny-oss'
import { v4 as uuidv4 } from 'uuid'
import { toast } from 'vue-sonner'
import { base64encode, safe64, utf16to8 } from '@/utils/tokenTools'
import * as tokenTools from '@/utils/tokenTools'
import fetch from '@/utils/fetch'
import { giteeConfig, githubConfig } from '@/config'

// 添加类型声明
declare global {
  interface Window {
    showDirectoryPicker(options?: { mode?: `read` | `readwrite` }): Promise<FileSystemDirectoryHandle>
  }
}

function getConfig(useDefault: boolean, platform: string) {
  if (useDefault) {
    // load default config file
    const config = platform === `github` ? githubConfig : giteeConfig
    const { username, repoList, branch, accessTokenList } = config

    // choose random token from access_token list
    const tokenIndex = Math.floor(Math.random() * accessTokenList.length)
    const accessToken = accessTokenList[tokenIndex].replace(`doocsmd`, ``)

    // choose random repo from repo list
    const repoIndex = Math.floor(Math.random() * repoList.length)
    const repo = repoList[repoIndex]

    return { username, repo, branch, accessToken }
  }

  // load configuration from localStorage
  const customConfig = JSON.parse(localStorage.getItem(`${platform}Config`)!)

  // split username/repo
  const repoUrl = customConfig.repo
    .replace(`https://${platform}.com/`, ``)
    .replace(`http://${platform}.com/`, ``)
    .replace(`${platform}.com/`, ``)
    .split(`/`)
  return {
    username: repoUrl[0],
    repo: repoUrl[1],
    branch: customConfig.branch || `master`,
    accessToken: customConfig.accessToken,
  }
}

/**
 * 获取 `年/月/日` 形式的目录
 * @returns string
 */
function getDir() {
  const date = new Date()
  const year = date.getFullYear()
  const month = (date.getMonth() + 1).toString().padStart(2, `0`)
  const day = date.getDate().toString().padStart(2, `0`)
  return `${year}/${month}/${day}`
}

/**
 * 根据文件名获取它以 `时间戳+uuid` 的形式
 * @param {string} filename 文件名
 * @returns {string} `时间戳+uuid`
 */
function getDateFilename(filename: string) {
  const currentTimestamp = new Date().getTime()
  const fileSuffix = filename.split(`.`)[1]
  return `${currentTimestamp}-${uuidv4()}.${fileSuffix}`
}

// -----------------------------------------------------------------------
// GitHub File Upload
// -----------------------------------------------------------------------

async function ghFileUpload(content: string, filename: string) {
  const useDefault = localStorage.getItem(`imgHost`) === `default`
  const { username, repo, branch, accessToken } = getConfig(
    useDefault,
    `github`,
  )
  const dir = getDir()
  const url = `https://api.github.com/repos/${username}/${repo}/contents/${dir}/`
  const dateFilename = getDateFilename(filename)
  const res = await fetch<{ content: {
    download_url: string
  } }, {
    content: {
      download_url: string
    }
    data?: {
      content: {
        download_url: string
      }
    }
  }>({
    url: url + dateFilename,
    method: `put`,
    headers: {
      Authorization: `token ${accessToken}`,
    },
    data: {
      content,
      branch,
      message: `Upload by ${window.location.href}`,
    },
  })
  const githubResourceUrl = `raw.githubusercontent.com/${username}/${repo}/${branch}/`
  const cdnResourceUrl = `fastly.jsdelivr.net/gh/${username}/${repo}@${branch}/`
  res.content = res.data?.content || res.content
  return useDefault
    ? res.content.download_url.replace(githubResourceUrl, cdnResourceUrl)
    : res.content.download_url
}

// -----------------------------------------------------------------------
// Gitee File Upload
// -----------------------------------------------------------------------

async function giteeUpload(content: any, filename: string) {
  const useDefault = localStorage.getItem(`imgHost`) === `default`
  const { username, repo, branch, accessToken } = getConfig(useDefault, `gitee`)
  const dir = getDir()
  const dateFilename = getDateFilename(filename)
  const url = `https://gitee.com/api/v5/repos/${username}/${repo}/contents/${dir}/${dateFilename}`
  const res = await fetch<{ content: {
    download_url: string
  } }, {
    content: {
      download_url: string
    }
    data: {
      content: {
        download_url: string
      }
    }
  }>({
    url,
    method: `POST`,
    data: {
      content,
      branch,
      access_token: accessToken,
      message: `Upload by ${window.location.href}`,
    },
  })
  res.content = res.data?.content || res.content
  return encodeURI(res.content.download_url)
}

// -----------------------------------------------------------------------
// Qiniu File Upload
// -----------------------------------------------------------------------

function getQiniuToken(accessKey: string, secretKey: string, putPolicy: {
  scope: string
  deadline: number
}) {
  const policy = JSON.stringify(putPolicy)
  const encoded = base64encode(utf16to8(policy))
  const hash = CryptoJS.HmacSHA1(encoded, secretKey)
  const encodedSigned = hash.toString(CryptoJS.enc.Base64)
  return `${accessKey}:${safe64(encodedSigned)}:${encoded}`
}

async function qiniuUpload(file: File) {
  const { accessKey, secretKey, bucket, region, path, domain } = JSON.parse(
    localStorage.getItem(`qiniuConfig`)!,
  )
  const token = getQiniuToken(accessKey, secretKey, {
    scope: bucket,
    deadline: Math.trunc(new Date().getTime() / 1000) + 3600,
  })
  const dir = path ? `${path}/` : ``
  const dateFilename = dir + getDateFilename(file.name)
  const observable = qiniu.upload(file, dateFilename, token, {}, { region })
  return new Promise<string>((resolve, reject) => {
    observable.subscribe({
      next: (result) => {
        console.log(result)
      },
      error: (err) => {
        reject(err.message)
      },
      complete: (result) => {
        resolve(`${domain}/${result.key}`)
      },
    })
  })
}

// -----------------------------------------------------------------------
// AliOSS File Upload
// -----------------------------------------------------------------------

async function aliOSSFileUpload(file: File) {
  const dateFilename = getDateFilename(file.name)
  const { region, bucket, accessKeyId, accessKeySecret, useSSL, cdnHost, path }
    = JSON.parse(localStorage.getItem(`aliOSSConfig`)!)
  const dir = path ? `${path}/${dateFilename}` : dateFilename
  const secure = useSSL === undefined || useSSL
  const protocol = secure ? `https` : `http`
  const client = new OSS({
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    secure,
  })

  try {
    await client.put(dir, file)
    return cdnHost ? `${cdnHost}/${dir}` : `${protocol}://${bucket}.${region}.aliyuncs.com/${dir}`
  }
  catch (e) {
    return Promise.reject(e)
  }
}

// -----------------------------------------------------------------------
// TxCOS File Upload
// -----------------------------------------------------------------------

async function txCOSFileUpload(file: File) {
  const dateFilename = getDateFilename(file.name)
  const { secretId, secretKey, bucket, region, path, cdnHost } = JSON.parse(
    localStorage.getItem(`txCOSConfig`)!,
  )
  const cos = new COS({
    SecretId: secretId,
    SecretKey: secretKey,
  })
  return new Promise<string>((resolve, reject) => {
    cos.putObject(
      {
        Bucket: bucket,
        Region: region,
        Key: `${path}/${dateFilename}`,
        Body: file,
      },
      (err, data) => {
        if (err) {
          reject(err)
        }
        else if (cdnHost) {
          resolve(
            path === ``
              ? `${cdnHost}/${dateFilename}`
              : `${cdnHost}/${path}/${dateFilename}`,
          )
        }
        else {
          resolve(`https://${data.Location}`)
        }
      },
    )
  })
}

// -----------------------------------------------------------------------
// Minio File Upload
// -----------------------------------------------------------------------

async function minioFileUpload(content: string, filename: string) {
  const dateFilename = getDateFilename(filename)
  const { endpoint, port, useSSL, bucket, accessKey, secretKey } = JSON.parse(
    localStorage.getItem(`minioConfig`)!,
  )
  const buffer = Buffer(content, `base64`)
  const conf: Minio.ClientOptions = {
    endPoint: endpoint,
    useSSL,
    accessKey,
    secretKey,
  }
  const p = Number(port || 0)
  const isCustomPort = p > 0 && p !== 80 && p !== 443
  if (isCustomPort)
    conf.port = p

  return new Promise<string>((resolve, reject) => {
    const minioClient = new Minio.Client(conf)
    try {
      minioClient.putObject(bucket, dateFilename, buffer, (e) => {
        if (e)
          reject(e)

        const host = `${useSSL ? `https://` : `http://`}${endpoint}${
          isCustomPort ? `:${port}` : ``
        }`
        const url = `${host}/${bucket}/${dateFilename}`
        // console.log("文件上传成功: ", url)
        resolve(url)
        // return `${endpoint}/${bucket}/${dateFilename}`;
      })
    }
    catch (e) {
      reject(e)
    }
  })
}

// -----------------------------------------------------------------------
// mp File Upload
// -----------------------------------------------------------------------
interface MpResponse {
  access_token: string
  expires_in: number
  errcode: number
  errmsg: string
}
async function getMpToken(appID: string, appsecret: string, proxyOrigin: string) {
  const data = localStorage.getItem(`mpToken:${appID}`)
  if (data) {
    const token = JSON.parse(data)
    if (token.expire && token.expire > new Date().getTime())
      return token.access_token
  }
  const requestOptions = {
    method: `POST`,
    data: {
      grant_type: `client_credential`,
      appid: appID,
      secret: appsecret,
    },
  }
  let url = `https://api.weixin.qq.com/cgi-bin/stable_token`
  if (proxyOrigin)
    url = `${proxyOrigin}/cgi-bin/stable_token`

  const res = await fetch<any, MpResponse>(url, requestOptions)
  if (res.access_token) {
    const tokenInfo = {
      ...res,
      expire: new Date().getTime() + res.expires_in * 1000,
    }
    localStorage.setItem(`mpToken:${appID}`, JSON.stringify(tokenInfo))
    return res.access_token
  }
  return ``
}
async function mpFileUpload(file: File) {
  const { appID, appsecret, proxyOrigin } = JSON.parse(
    localStorage.getItem(`mpConfig`)!,
  )

  const access_token = await getMpToken(appID, appsecret, proxyOrigin)
  if (!access_token)
    throw new Error(`获取 access_token 失败`)

  const formdata = new FormData()
  formdata.append(`media`, file, file.name)

  const requestOptions = {
    method: `POST`,
    data: formdata,
  }

  let url = `https://api.weixin.qq.com/cgi-bin/material/add_material?access_token=${access_token}&type=image`
  if (proxyOrigin)
    url = `${proxyOrigin}/cgi-bin/material/add_material?access_token=${access_token}&type=image`

  const res = await fetch<any, { url: string }>(url, requestOptions)

  if (!res.url)
    throw new Error(`上传失败，未获取到URL`)

  let imageUrl = res.url
  if (proxyOrigin && window.location.href.startsWith(`http`))
    imageUrl = `https://wsrv.nl?url=${encodeURIComponent(imageUrl)}`

  return imageUrl
}

// -----------------------------------------------------------------------
// Cloudflare R2 File Upload
// -----------------------------------------------------------------------

async function r2Upload(file: File) {
  const { accountId, accessKey, secretKey, bucket, path, domain } = JSON.parse(
    localStorage.getItem(`r2Config`)!,
  )
  const dir = path ? `${path}/` : ``
  const filename = dir + getDateFilename(file.name)
  const client = new S3Client({ region: `auto`, endpoint: `https://${accountId}.r2.cloudflarestorage.com`, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } })

  return new Promise<string>((resolve, reject) => {
    const putObjectCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: filename,
      ContentType: file.type,
      Body: file,
    })
    client.send(putObjectCommand).then(() => {
      resolve(`${domain}/${filename}`)
    }).catch((err) => {
      reject(err)
    })
  })
}

// -----------------------------------------------------------------------
// formCustom File Upload
// -----------------------------------------------------------------------

async function formCustomUpload(content: string, file: File) {
  const str = `
    async (CUSTOM_ARG) => {
      ${localStorage.getItem(`formCustomConfig`)}
    }
  `
  return new Promise<string>((resolve, reject) => {
    const exportObj = {
      content, // 待上传图片的 base64
      file, // 待上传图片的 file 对象
      util: {
        axios: fetch, // axios 实例
        CryptoJS, // 加密库
        OSS, // tiny-oss
        COS, // cos-js-sdk-v5
        Buffer, // buffer-from
        uuidv4, // uuid
        qiniu, // qiniu-js
        tokenTools, // 一些编码转换函数
        getDir, // 获取 年/月/日 形式的目录
        getDateFilename, // 根据文件名获取它以 时间戳+uuid 的形式
      },
      okCb: resolve, // 重要: 上传成功后给此回调传 url 即可
      errCb: reject, // 上传失败调用的函数
    }
    // eslint-disable-next-line no-eval
    eval(str)(exportObj).catch((err: any) => {
      console.error(err)
      reject(err)
    })
  })
}

// -----------------------------------------------------------------------
// Local File Upload
// -----------------------------------------------------------------------

interface LocalConfig {
  handle: FileSystemDirectoryHandle | null
  path: string
  imagePathTemplateInMd: string
}

let localConfig: LocalConfig = {
  handle: null,
  path: ``,
  imagePathTemplateInMd: `/{name}.{ext}`,
}

// 初始化本地配置
const savedConfig = localStorage.getItem(`localConfig`)
if (savedConfig) {
  const config = JSON.parse(savedConfig)
  localConfig = {
    ...localConfig,
    path: config.path || ``,
    imagePathTemplateInMd: config.imagePathTemplateInMd || `/{name}.{ext}`,
  }
}

function getLocalConfig() {
  return localConfig
}

async function checkLocalImageHostConfig(): Promise<boolean> {
  const imgHost = localStorage.getItem(`imgHost`)
  const config = localStorage.getItem(`localConfig`)

  // 如果不是本地图床，直接返回 true
  if (imgHost !== `local`)
    return true

  // 如果是本地图床，但没有配置或 handle 无效
  if (!config || !localConfig.handle)
    return false

  // 验证权限是否有效
  return await verifyLocalDirectoryAccess()
}

async function requestLocalDirectory() {
  try {
    const handle = await window.showDirectoryPicker({
      mode: `readwrite`,
    })
    localConfig.handle = handle
    localConfig.path = handle.name

    // 获取已有配置
    const existingConfig = localStorage.getItem(`localConfig`)
    const config = existingConfig ? JSON.parse(existingConfig) : {}

    // 保存配置,保留 imagePathTemplateInMd
    localStorage.setItem(`localConfig`, JSON.stringify({
      ...config,
      path: handle.name,
      imagePathTemplateInMd: config.imagePathTemplateInMd || `/{name}.{ext}`,
    }))

    // 同步更新内存中的配置
    localConfig.imagePathTemplateInMd = config.imagePathTemplateInMd || `/{name}.{ext}`

    return true
  }
  catch (err) {
    // 用户主动取消不提示错误
    if (err instanceof Error && err.name === `AbortError`)
      return false

    console.error(`Failed to get directory permission:`, err)
    toast(`获取目录权限失败`)
    return false
  }
}

function isLocalPath(path: string): boolean {
  return /^(\.\/|\.\.\/|\/|[^:]+\/)/.test(path)
}

// 从路径中根据模板提取文件名
function extractFilenameFromPath(path: string, template: string): string {
  // 转义特殊字符,将模板转为正则
  const pattern = template
    .replace(/\//g, `\\/`) // 转义斜杠
    .replace(/\./g, `\\.`) // 转义点号
    .replace(`{name}`, `(?<name>.+?)`) // 捕获文件名
    .replace(`{ext}`, `(?<ext>[^/]+)`) // 捕获扩展名

  const regex = new RegExp(pattern)
  const match = path.match(regex)

  if (!match?.groups) {
    // 如果无法匹配模板,则移除开头的 ./ ../ / 作为后备方案
    return path.replace(/^(\.\/|\.\.\/|\/)+/, ``)
  }

  const { name, ext } = match.groups
  return `${name}.${ext}`
}

// 获取文件内容并创建 URL
async function getLocalImagePreview(path: string): Promise<string | null> {
  if (!localConfig.handle)
    return null

  try {
    const filename = extractFilenameFromPath(path, localConfig.imagePathTemplateInMd)
    const fileHandle = await localConfig.handle.getFileHandle(filename)
    const file = await fileHandle.getFile()
    return URL.createObjectURL(file)
  }
  catch (err) {
    console.error(`Failed to read local file:`, err)
    return null
  }
}

async function verifyLocalDirectoryAccess() {
  const config = localStorage.getItem(`localConfig`)
  if (!config)
    return false

  if (!localConfig.handle) {
    toast(`需要授权本地存储目录访问权限`)
    const hasPermission = await requestLocalDirectory()
    if (!hasPermission)
      return false
  }

  try {
    // 尝试创建一个临时文件来验证权限
    const testFileName = `.permission_test`
    try {
      const fileHandle = await localConfig.handle!.getFileHandle(testFileName, { create: true })
      // 创建一个可写流并立即关闭它
      const writable = await fileHandle.createWritable()
      await writable.close()
      // 删除测试文件
      await localConfig.handle!.removeEntry(testFileName)
      return true
    }
    catch {
      throw new Error(`Permission denied`)
    }
  }
  catch (err) {
    console.error(`Directory permission verification failed:`, err)
    toast(`本地存储目录访问权限已失效，请重新授权`)
    localConfig.handle = null
    // 让用户手动点击"选择目录"按钮重新授权
    return false
  }
}

async function localFileUpload(file: File) {
  if (!localConfig.handle) {
    toast(`需要选择本地存储目录`)
    const hasPermission = await requestLocalDirectory()
    if (!hasPermission)
      throw new Error(`需要选择本地存储目录`)
  }

  try {
    const filename = getDateFilename(file.name)
    const fileExt = filename.split(`.`).pop() || ``
    const baseName = filename.slice(0, -fileExt.length - 1)

    // 直接存储文件
    const fileHandle = await localConfig.handle!.getFileHandle(filename, { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(file)
    await writable.close()

    // 返回配置的图片路径格式
    return localConfig.imagePathTemplateInMd
      .replace(`{name}`, baseName)
      .replace(`{ext}`, fileExt)
  }
  catch (err) {
    console.error(`Failed to save file:`, err)
    if (err instanceof Error && err.name === `NotAllowedError`) {
      toast(`本地存储目录访问权限已失效，请点击"选择目录"按钮重新授权`)
      localConfig.handle = null
    }
    throw new Error(`保存文件失败`)
  }
}

function fileUpload(content: string, file: File) {
  const imgHost = localStorage.getItem(`imgHost`) || `default`

  switch (imgHost) {
    case `local`:
      return localFileUpload(file)
    case `aliOSS`:
      return aliOSSFileUpload(file)
    case `minio`:
      return minioFileUpload(content, file.name)
    case `txCOS`:
      return txCOSFileUpload(file)
    case `qiniu`:
      return qiniuUpload(file)
    case `gitee`:
      return giteeUpload(content, file.name)
    case `github`:
      return ghFileUpload(content, file.name)
    case `mp`:
      return mpFileUpload(file)
    case `r2`:
      return r2Upload(file)
    case `formCustom`:
      return formCustomUpload(content, file)
    default:
      // return file.size / 1024 < 1024
      //     ? giteeUpload(content, file.name)
      //     : ghFileUpload(content, file.name);
      return ghFileUpload(content, file.name)
  }
}

// 统一在一处导出所有内容
export default {
  fileUpload,
  requestLocalDirectory,
  getLocalImagePreview,
  verifyLocalDirectoryAccess,
  getLocalConfig,
  checkLocalImageHostConfig,
  isLocalPath,
}
