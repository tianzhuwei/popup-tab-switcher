export function log(message: string, ...args: any): void {
  if (PRODUCTION) {
    return
  }
  console.log(message, ...args)
}
