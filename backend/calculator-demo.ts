import { Calculator } from './src/calculator.js';

const calc = new Calculator();

console.log('=== Calculator Demo ===\n');

console.log('Basic Operations:');
console.log(`5 + 3 = ${calc.add(5, 3)}`);
console.log(`10 - 4 = ${calc.subtract(10, 4)}`);
console.log(`6 * 7 = ${calc.multiply(6, 7)}`);
console.log(`15 / 3 = ${calc.divide(15, 3)}`);
console.log(`17 % 5 = ${calc.modulo(17, 5)}`);

console.log('\nAdvanced Operations:');
console.log(`2 ^ 8 = ${calc.power(2, 8)}`);
console.log(`√16 = ${calc.sqrt(16)}`);

console.log('\nExpression Evaluation:');
console.log(`(5 + 3) * 2 = ${calc.evaluate('(5 + 3) * 2')}`);
console.log(`10 / 2 + 3 * 4 = ${calc.evaluate('10 / 2 + 3 * 4')}`);

console.log('\nError Handling:');
try {
    calc.divide(10, 0);
} catch (error) {
    console.log(`Division by zero: ${(error as Error).message}`);
}

try {
    calc.sqrt(-4);
} catch (error) {
    console.log(`Square root of negative: ${(error as Error).message}`);
}
