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
import {ByteString} from '../types/ByteString';
import {Atomize} from '../../core/Atomize';
import {FilterOperation} from './FilterOperation';
import {FilterExpressionMode} from './FilterExpressionMode';
import {deserializeMemoryBlock, deserializeTable} from '../../utils/Serializer';

/**
 * Class to process filters on Tables.
 * This class is meant to be used by filter workers, but it is safe to use on the main thread as well.
 * Creates a new instance and reconstructs the Heap, Memory Object and Table specified in the config object.
 * NOTE: Heap, MemoryBlock and Table classes are thread safe.
 * @class FilterProcessor
 * @param {{table: TableSerialized}} config - Configuration object.
 */
export class FilterProcessor {
    constructor(config) {
        this.mTable = deserializeTable(config.table);
        this.mRow = this.mTable.getBinaryRow(0);
    }

    /**
     * Fetches the memory from this filter processor and invalidates all objects linked to it.
     * WARNING: This filter worker will not work after this function is called and before a new memory block is set.
     * @return {ArrayBuffer|SharedArrayBuffer}
     */
    fetchMemory() {
        const buffer = this.mTable.memory.buffer;
        this.mTable = null;
        this.mRow = null;
        return buffer;
    }

    /**
     * Processes the rules in batches the size configures in the config object
     * @param {{
     * rules: Array,
     * mode: FilterExpressionMode,
     * resultDescription: Array,
     * resultTable: TableSerialized,
     * indices: MemoryBlockSerialized,
     * rowBatchSize: number
     * }} config - Configuration object.
     */
    process(config) {
        const indicesMemory = deserializeMemoryBlock(config.indices);
        const indices = new Uint32Array(indicesMemory.buffer, indicesMemory.address, 2);
        const batchSize = config.rowBatchSize;
        const resultTable = deserializeTable(config.resultTable);
        const rowCount = this.mTable.rowCount;
        const row = this.mRow;
        const filterTester = this._generateExpressionTester(config.rules, config.mode, row);
        const resultWriter = this._generateResultWriter(resultTable, config.resultDescription, row);
        let i;
        let n;
        let r;
        for (i = Atomize.add(indices, 0, batchSize); i < rowCount; i = Atomize.add(indices, 0, batchSize)) {
            n = Math.min(i + batchSize, rowCount);
            for (r = i; r < n; ++r) {
                row.index = r;
                if (filterTester()) {
                    resultWriter(r);
                }
            }
        }
    }

    /**
     * Generates a function that writes the row values, as specified in the `description` array, to the specified
     * result table.
     * NOTE: The same Row instance that will be used to iterate through the table must be passed to this method, Row
     * instances are simply pointers to a position in the table that are shifted as they change row. This function takes
     * advantage of such behaviour to improve performance.
     * @param {Table} resultTable - The table to write to.
     * @param {Array} description - Result description object.
     * @param {Row} baseRow - The base row that will be used to iterate through the table.
     * @return {function(index:number):void}
     * @private
     */
    _generateResultWriter(resultTable, description, baseRow) {
        const resultRow = resultTable.getRow(0);
        const writers = [];
        for (let i = 0; i < description.length; ++i) {
            if (description[i].as) {
                const getter = baseRow.accessors[baseRow.names[description[i].column]].getter;
                const setter = resultRow.accessors[resultRow.names[description[i].as]].setter;
                writers.push(function resultWriterField() {
                    setter(getter());
                });
            } else {
                const setter = resultRow.accessors[resultRow.names['']].setter;
                writers.push(function resultWriterRowIndex(index) {
                    setter(index);
                });
            }
        }

        const writersLength = writers.length;
        let i;
        return function resultWriter(index) {
            resultRow.index = resultTable.addRows(1);
            for (i = 0; i < writersLength; ++i) {
                writers[i](index);
            }
        };
    }

    /**
     * Generates a function that tests the specified rule sets against the specified row.
     * NOTE: The same Row instance that will be used to iterate through the table must be passed to this method.
     * @param {FilterExpression} expression - An array of rule sets to test against.
     * @param {FilterExpressionMode} mode - The mode in which the rules should be interpreted.
     * @param {Row} row - The row instance that will be used to iterate through the table.
     * @return {function():boolean}
     * @private
     */
    _generateExpressionTester(expression, mode, row) {
        if (!expression || !expression.length) {
            return function filterTesterEmpty() {
                return true;
            };
        }

        const testers = [];
        const testersLength = expression.length;
        for (let i = 0; i < testersLength; ++i) {
            testers.push(this._generateClauseTester(expression[i], mode, row));
        }

        if (mode === FilterExpressionMode.DNF || mode === FilterExpressionMode.disjunctiveNormalForm) {
            return function filterTesterDNF() {
                for (let i = 0; i < testersLength; ++i) {
                    if (testers[i]()) {
                        return true;
                    }
                }
                return false;
            };
        }

        return function filterTesterCNF() {
            for (let i = 0; i < testersLength; ++i) {
                if (!testers[i]()) {
                    return false;
                }
            }
            return true;
        };
    }

    /**
     * Generates a function that tests the specified rule set against the specified row.
     * NOTE: The same Row instance that will be used to iterate through the table must be passed to this method.
     * @param {FilterClause} clause - The rule set to test.
     * @param {FilterExpressionMode} mode - The mode in which the rule should be interpreted.
     * @param {Row} row - The row instance that will be used to iterate through the table.
     * @return {function():boolean}
     * @private
     */
    _generateClauseTester(clause, mode, row) {
        const testers = [];
        const testersLength = clause.length;
        for (let i = 0; i < testersLength; ++i) {
            testers.push(this._generateRuleTester(clause[i], row));
        }

        if (mode === FilterExpressionMode.DNF || mode === FilterExpressionMode.disjunctiveNormalForm) {
            return function ruleTesterDNF() {
                for (let i = 0; i < testersLength; ++i) {
                    if (!testers[i]()) {
                        return false;
                    }
                }
                return true;
            };
        }

        return function ruleTesterCNF() {
            for (let i = 0; i < testersLength; ++i) {
                if (testers[i]()) {
                    return true;
                }
            }
            return false;
        };
    }

    /**
     * Generate a function that tests the specified field in the specified row.
     * NOTE: The same Row instance that will be used to iterate through the table must be passed to this method.
     * @param {FilterRule} rule - Object containing the field and parameters to test.
     * @param {Row} row - The row instance that will be used to iterate through the table.
     * @return {function():boolean|null}
     * @private
     */
    _generateRuleTester(rule, row) {
        const column = this.mTable.header.columns[row.names[rule.field]];
        const getter = row.accessors[row.names[rule.field]].getter;
        switch (rule.operation) {
            case FilterOperation.contains: {
                const value = ByteString.fromString(rule.value);
                return function filterContains() { return getter().containsCase(value); };
            }

            case FilterOperation.notContains: {
                const value = ByteString.fromString(rule.value);
                return function filterNotContains() { return !getter().containsCase(value); };
            }

            case FilterOperation.in: {
                if (column.type === ByteString) {
                    const values = rule.value.map(v => ByteString.fromString(v));
                    const n = values.length;
                    let i;
                    return function filterIn() {
                        const toTest = getter();
                        for (i = 0; i < n; ++i) {
                            if (toTest.equalsCase(values[i])) {
                                return true;
                            }
                        }
                        return false;
                    };
                }

                const values = rule.value.map(v => parseFloat(v));
                const n = values.length;
                let i;
                return function filterIn() {
                    const toTest = getter();
                    for (i = 0; i < n; ++i) {
                        if (toTest === values[i]) {
                            return true;
                        }
                    }
                    return false;
                };
            }

            case FilterOperation.notIn: {
                if (column.type === ByteString) {
                    const values = rule.value.map(v => ByteString.fromString(v));
                    const n = values.length;
                    let i;
                    return function filterNotIn() {
                        const toTest = getter();
                        for (i = 0; i < n; ++i) {
                            if (toTest.equalsCase(values[i])) {
                                return false;
                            }
                        }
                        return true;
                    };
                }

                const values = rule.value.map(v => parseFloat(v));
                const n = values.length;
                let i;
                return function filterNotIn() {
                    const toTest = getter();
                    for (i = 0; i < n; ++i) {
                        if (toTest === values[i]) {
                            return false;
                        }
                    }
                    return true;
                };
            }

            case FilterOperation.equal: {
                if (column.type === ByteString) {
                    const value = ByteString.fromString(rule.value);
                    return function filterEquals() {
                        return getter().equalsCase(value);
                    };
                }
                const value = parseFloat(rule.value);
                return function filterEquals() {
                    return getter() === value;
                };
            }

            case FilterOperation.notEqual: {
                if (column.type === ByteString) {
                    const value = ByteString.fromString(rule.value);
                    return function filterEquals() {
                        return !getter().equalsCase(value);
                    };
                }
                const value = parseFloat(rule.value);
                return function filterNotEqual() {
                    return getter() !== value;
                };
            }

            case FilterOperation.greaterThan: {
                const value = parseFloat(rule.value);
                return function filterMoreThanOrEqual() {
                    return getter() > value;
                };
            }

            case FilterOperation.greaterThanOrEqual: {
                const value = parseFloat(rule.value);
                return function filterMoreThan() {
                    return getter() >= value;
                };
            }

            case FilterOperation.lessThan: {
                const value = parseFloat(rule.value);
                return function filterLessThan() {
                    return getter() < value;
                };
            }

            case FilterOperation.lessThanOrEqual: {
                const value = parseFloat(rule.value);
                return function filterLessThanOrEqual() {
                    return getter() <= value;
                };
            }

            default:
                break;
        }
        return null;
    }
}
