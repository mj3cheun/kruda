/*
 * Copyright (c) 2019 Uncharted Software Inc.
 * http://www.uncharted.software/
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import {Header} from './Header';
import {Row} from './Row';

/**
 * Class that represents a table in binary memory.
 * @class Table
 * @param {MemoryBlock} memory - The MemoryBlock containing the table's data
 */
export class Table {
    constructor(memory) {
        this.mMemory = memory;
        this.mHeader = new Header(this.mMemory);
    }

    /**
     * Destroys this table instance and frees the memory associated with it. This method must be called when the memory
     * associated to this table is no longer needed to avoid memory leaks in kruda's internal memory management system.
     */
    destroy() {
        this.mMemory.free();
        delete this.mMemory;
        delete this.mHeader;
    }

    /**
     * Crates a new empty Table with the specified columns in the supplied memory. The table will
     * be able to grow as big as the memory that contains it.
     * @param {ColumnDescriptor[]} columns - The columns for the new Table
     * @param {MemoryBlock} memory - The memory where the new Table will live
     * @return {Table}
     */
    static emptyFromColumns(columns, memory) {
        const binaryHeader = Header.binaryFromColumns(columns);
        return this.emptyFromBinaryHeader(binaryHeader, memory);
    }

    /**
     * Crates a new empty Table with the specified header descriptor in the supplied memory. The table will
     * be able to grow as big as the memory that contains it.
     * @param {HeaderDescriptor} header - The header descriptor tu use
     * @param {MemoryBlock} memory - The memory where the new Table will live
     * @return {Table}
     */
    static emptyFromHeader(header, memory) {
        const binaryHeader = Header.buildBinaryHeader(header);
        return this.emptyFromBinaryHeader(binaryHeader, memory);
    }

    /**
     * Crates a new empty Table with the specified binary header in the supplied memory. The table will
     * be able to grow as big as the memory that contains it.
     * @param {ArrayBuffer} header - The binary header to use
     * @param {MemoryBlock} memory - The memory where the new Table will live
     * @return {Table}
     */
    static emptyFromBinaryHeader(header, memory) {
        const memoryView = new Uint8Array(memory.buffer);
        const headerView = new Uint8Array(header);
        memoryView.set(headerView, memory.address);
        return new Table(memory);
    }

    /**
     * The header of this table. Contains column names, order in memory, original order and type information.
     * @type {Header}
     */
    get header() {
        return this.mHeader;
    }

    /**
     * The total number of rows in this table.
     * @type {number}
     */
    get rowCount() {
        return this.mHeader.rowCount;
    }

    /**
     * The memory block that contains this table's layout and data.
     * @type {MemoryBlock}
     */
    get memory() {
        return this.mMemory;
    }

    /**
     * The offset, in bytes, from the beginning of this table to the row data.
     * @type {number}
     */
    get dataOffset() {
        return this.mHeader.length;
    }

    /**
     * Adds the specified number of rows to this table and returns the old row count.
     * NOTE: The memory in the new rows is NOT cleared before returning.
     * @param {number} count - The number of rows to add
     * @returns {number}
     */
    addRows(count = 1) {
        return this.mHeader.addRows(count);
    }

    /**
     * Gets a new Row instance pointing at the row at the specified index.
     * NOTE: The returned row can be moved to point to a different row by changing its `index` property.
     * @param {number} index - The index of the row to get the data from.
     * @param {Row=} row - An optional row, belonging to this table, to reuse. Useful to reduce garbage collection.
     * @return {Row}
     */
    getRow(index, row = new Row(this, index)) {
        /// #if !_DEBUG
        /*
        /// #endif
        if (!index >= this.rowCount) {
            throw 'ERROR: Index out of bounds!';
        }
        /// #if !_DEBUG
         */
        /// #endif
        row.index = index;
        return row;
    }

    /**
     * Gets a new Row instance pointing at the row at the specified index. The resulting row will return
     * {@link ByteString} instances for the column fields which are strings. ByteStrings are faster to work with but are
     * not replacements for JavaScript strings.
     * NOTE: The returned row can be moved to point to a different row by changing its `index` property.
     * @param {number} index - The index of the row to get the data from.
     * @param {Row=} row - An optional row, belonging to this table, to reuse. Useful to reduce garbage collection.
     * @return {Row}
     */
    getBinaryRow(index, row = new Row(this, index, true)) {
        /// #if !_DEBUG
        /*
        /// #endif
        if (!index >= this.rowCount) {
            throw 'ERROR: Index out of bounds!';
        }
        /// #if !_DEBUG
         */
        /// #endif
        row.index = index;
        return row;
    }

    /**
     * Iterates through all the rows in this table and invokes the provided callback `itr` on each iteration.
     * WARNING: This function is designed to avoid garbage collection and improve performance so the row passed to the
     * `itr` callback is reused, the row cannot be stored as its contents will change. If you need to store unique rows
     * consider using the `getRow` method.
     * @param {function(row:Row, i:number):void} itr - Callback function to invoke for each row in this table.
     */
    forEach(itr) {
        const row = new Row(this, 0);
        itr(row, 0);
        for (let i = 1, n = this.rowCount; i < n; ++i) {
            row.index = i;
            itr(row, i);
        }
    }

    /*
     * Iterable protocol implementation: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols#iterable
     * WARNING: This function is designed to avoid garbage collection and improve performance so the row passed to the
     * `itr` callback is reused, the row cannot be stored as its contents will change. If you need to store unique rows
     * consider using the `getRow` method.
     * @return {Iterator}
     */
    [Symbol.iterator]() {
        return {
            i: 0,
            n: this.rowCount,
            row: new Row(this, 0),
            next() {
                if (this.i < this.n) {
                    this.row.index = this.i++;
                    return { value: this.row, done: false };
                }
                return { value: undefined, done: true };
            },
        };
    }
}
