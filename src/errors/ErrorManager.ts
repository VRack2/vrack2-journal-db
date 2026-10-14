/*
 * Copyright © 2022 Boris Bobylev. All rights reserved.
 * Licensed under the Apache License, Version 2.0
 */

import CoreError from "./CoreError.ts"

/**
 * Description of one additional-data property of a registered error.
 * In vrack2-core this is the validator's `BasicType`; here `rules` is pure
 * metadata (stored and compared, never used to validate), so it is typed as
 * the name of the property's primitive type (e.g. 'number', 'string').
 */
type RuleType = string

interface RegisteredError {
    /** Property for error grouping */
    name: string,
    /**
     * The single canonical identifier of the error — a short readable word
     * (like a VS_ERROR_DATABASE_NF). This is what lookups and docs use.
     */
    short: string,
    /** Error string (description) */
    description: string,
    /**
     * You can specify additional data when creating an error.
     * If these data are standardized - you can specify rules for them.
     * These rules do not validate the additional data.
     * But they can make it easier to understand these properties.
     * */
    rules: { [key: string]: RuleType }
}


/**
 * A simple class for creating errors.
 * This centralized class is useful because you can find out the
 * list of all registered errors and which group/component they belong to.
 */
class ErrorManager {

    /**
     * List of registered errors
    */
    private registeredList: Array<RegisteredError> = []

    /**
     * Error registration. An error must be registered before creating it
     *
     * @param name Property for error grouping
     * @param short Readable unique identifier (the canonical error ID)
     * @param description Error string (description)
     */
    register(name: string, short: string, description: string, rules: { [key: string]: RuleType } = {}) {
        const reg = this.getRegistered(short)
        if (reg !== null) {
            // Если уже есть идентичная запись - просто игнорим
            if (reg.name === name && reg.short === short && reg.description === description && JSON.stringify(reg.rules) === JSON.stringify(rules)) {
                return
            }else {
                throw this.make('EM_CODE_EXISTS', { short })
            }
        }
        const nr = { name, short, description, rules }
        this.registeredList.push(nr)
    }

    /**
     * Bulk error registration: registers every entry of the list at once.
     * `name` is the group (component) common for the whole list.
     * Atomic: if any entry conflicts with an already registered error
     * (or duplicates a short inside the list), nothing is registered
     * and EM_CODE_EXISTS is thrown.
     *
     * @param name Property for error grouping (component, common for the whole list)
     * @param list Array of { short, description, rules? }
    */
    registerMany(name: string, list: Array<{ short: string, description: string, rules?: { [key: string]: RuleType } }>) {
        // 1) Проверяем конфликтность: дубли short внутри списка + совпадение с уже зарегистрированными
        const seen = new Set<string>()
        for (const entry of list) {
            if (seen.has(entry.short)) throw this.make('EM_CODE_EXISTS', { short: entry.short })
            seen.add(entry.short)
            if (this.getRegistered(entry.short) !== null) throw this.make('EM_CODE_EXISTS', { short: entry.short })
        }
        // 2) Атомарно регистрируем (конфликтов нет — просто пушим)
        for (const entry of list) {
            const nr: RegisteredError = { name, short: entry.short, description: entry.description, rules: entry.rules ?? {} }
            this.registeredList.push(nr)
        }
    }

    /**
     * Creating an instance of an error
     *
     * @param short
     * @param additional
     */
    make(short: string, additional = {}) {
        const reg = this.getRegistered(short)
        if (reg === null) throw this.make('EM_CODE_NOT_FOUND')
        const ne = new CoreError(reg.name, reg.description, reg.short)

        // Убираем из стека вызовы ErrorManager.make()
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(ne, this.make);
        }

        ne.vAdd = Object.keys(additional)
        return Object.assign(ne, additional)
    }


    /**
     * Converts a normal error to a VRack error
     *
     * @param error Ошибка для преобразования
     */
    convert(error: any) {
        if (error.vError) return error
        const ne = this.make('EM_ERROR_CONVERT')
        ne.import(error)
        return ne
    }

    /**
     * Проверяет является ли ошибка VRack2 Error
     * и соответствует ли код переданной ошибке (проверяет vShort)
    */
    isCode(error: any, code: string){
        if (!this.isError(error)) return false
        if (error.vShort === code) return true
        return false
    }

    /**
     * Проверяет - принадлежит объект ошибки VRack2 Error
     *
     * Это не обязательно должен быть класс CoreError но и
     * любой сериализированный класс ошибки VRack2
    */
    isError(error: any){
        if (error instanceof CoreError) return true
        if (error.vError && error.vShort !== undefined) return true
        return false
    }

    /**
     * Searches for an error by code or short
     *
     * @param short Short error code or search error code
    */
    private getRegistered(short: string): RegisteredError | null {
        for (const registered of this.registeredList) if (registered.short === short) return registered
        return null
    }
}



const GlobalErrorManager = new ErrorManager()
GlobalErrorManager.registerMany('ErrorManager', [
    { short: 'EM_CODE_EXISTS', description: 'Registering a different record with an already registered short identifier.' },
    { short: 'EM_CODE_NOT_FOUND', description: 'No such error found' },
    { short: 'EM_ERROR_CONVERT', description: 'Converted error' },
])
export default GlobalErrorManager
