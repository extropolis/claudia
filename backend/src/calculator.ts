export class Calculator {
    add(a: number, b: number): number {
        return a + b;
    }

    subtract(a: number, b: number): number {
        return a - b;
    }

    multiply(a: number, b: number): number {
        return a * b;
    }

    divide(a: number, b: number): number {
        if (b === 0) {
            throw new Error('Cannot divide by zero');
        }
        return a / b;
    }

    modulo(a: number, b: number): number {
        if (b === 0) {
            throw new Error('Cannot perform modulo with zero');
        }
        return a % b;
    }

    power(base: number, exponent: number): number {
        return Math.pow(base, exponent);
    }

    sqrt(a: number): number {
        if (a < 0) {
            throw new Error('Cannot calculate square root of negative number');
        }
        return Math.sqrt(a);
    }

    evaluate(expression: string): number {
        const sanitized = expression.replace(/[^0-9+\-*/().\s]/g, '');

        if (sanitized !== expression) {
            throw new Error('Invalid characters in expression');
        }

        try {
            const result = Function(`"use strict"; return (${sanitized})`)();
            if (typeof result !== 'number' || !isFinite(result)) {
                throw new Error('Invalid expression result');
            }
            return result;
        } catch (error) {
            throw new Error('Invalid expression');
        }
    }
}

export const calculator = new Calculator();
