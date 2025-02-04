import { marked } from 'marked'
import fileUtils from './file'

const { getLocalImagePreview, isLocalPath } = fileUtils

// 添加一个函数来处理本地图片
function processLocalImages() {
  console.log(`processLocalImages called`)
  const images = document.querySelectorAll(`img[data-local-src]:not([data-processing])`)
  console.log(`found unprocessed images:`, images.length)

  images.forEach(async (img) => {
    const localSrc = img.getAttribute(`data-local-src`)
    console.log(`processing image with src:`, localSrc)
    if (localSrc && isLocalPath(localSrc)) {
      // 标记为正在处理
      img.setAttribute(`data-processing`, `true`)
      try {
        const previewUrl = await getLocalImagePreview(localSrc)
        console.log(`got preview url:`, previewUrl)
        // 处理完成后移除标记
        img.removeAttribute(`data-processing`)
        if (previewUrl) {
          img.setAttribute(`src`, previewUrl)
          // 移除 data-local-src 属性，避免重复处理
          img.removeAttribute(`data-local-src`)
        }
      }
      catch (error) {
        console.error(`Error processing image:`, error)
        // 处理失败时也移除处理中标记，允许重试
        img.removeAttribute(`data-processing`)
      }
    }
  })
}

// 导出函数
export { marked, processLocalImages }
