declare const DEVELOPMENT: boolean
declare const PRODUCTION: boolean

declare module '*.module.scss' {
  const classes: {[key: string]: string}
  export default classes
}

declare module '*.scss' {
  const content: string
  export default content
}
