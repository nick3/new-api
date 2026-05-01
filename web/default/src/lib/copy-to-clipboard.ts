/**
 * Fallback copy method using document.execCommand (works in HTTP)
 */
function fallbackCopyToClipboard(text: string): boolean {
  const textArea = document.createElement('textarea')
  const activeElement = document.activeElement
  const container =
    activeElement instanceof HTMLElement
      ? (activeElement.closest('[role="dialog"]') ?? document.body)
      : document.body

  textArea.value = text
  textArea.style.position = 'fixed'
  textArea.style.left = '-999999px'
  textArea.style.top = '-999999px'
  textArea.style.opacity = '0'
  textArea.setAttribute('readonly', '')

  container.appendChild(textArea)

  try {
    textArea.focus()
    textArea.select()

    const range = document.createRange()
    range.selectNodeContents(textArea)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    textArea.setSelectionRange(0, text.length)

    return document.execCommand('copy')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Fallback copy failed:', err)
    return false
  } finally {
    container.removeChild(textArea)
    window.getSelection()?.removeAllRanges()
  }
}

/**
 * Copy text to clipboard with fallback support for HTTP environments
 *
 * @param text - The text to copy
 * @returns Promise that resolves to true if successful, false otherwise
 *
 * @example
 * ```ts
 * const success = await copyToClipboard('Hello, World!')
 * if (success) {
 *   console.log('Copied successfully')
 * }
 * ```
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Guard for SSR / non-browser environments
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false
  }

  // Try modern clipboard API first (HTTPS required)
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Clipboard API failed, trying fallback method:', error)
      // Try fallback method
      return fallbackCopyToClipboard(text)
    }
  } else {
    // Use fallback method directly
    return fallbackCopyToClipboard(text)
  }
}
