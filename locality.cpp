#include <iostream>
#include <chrono>
using namespace std;

int main() {

    const int N = 5000;

    // Dynamically allocate a 2D array
    int **a = new int*[N];

    for (int i = 0; i < N; i++) {
        a[i] = new int[N];
    }

    // Initialize array
    for (int i = 0; i < N; i++) {
        for (int j = 0; j < N; j++) {
            a[i][j] = i + j;
        }
    }

    long long sum = 0;

    // -------------------------------
    // ROW-MAJOR ACCESS
    // -------------------------------

    auto start1 = chrono::high_resolution_clock::now();

    for (int i = 0; i < N; i++) {
        for (int j = 0; j < N; j++) {
            sum += a[i][j];
        }
    }

    auto end1 = chrono::high_resolution_clock::now();

    auto rowTime =
        chrono::duration_cast<chrono::microseconds>
        (end1 - start1).count();


    // -------------------------------
    // COLUMN-MAJOR ACCESS
    // -------------------------------

    sum = 0;

    auto start2 = chrono::high_resolution_clock::now();

    for (int j = 0; j < N; j++) {
        for (int i = 0; i < N; i++) {
            sum += a[i][j];
        }
    }

    auto end2 = chrono::high_resolution_clock::now();

    auto columnTime =
        chrono::duration_cast<chrono::microseconds>
        (end2 - start2).count();


    // -------------------------------
    // CALCULATE RATIO
    // -------------------------------

    double ratio = (double)columnTime / rowTime;


    // -------------------------------
    // DISPLAY RESULTS
    // -------------------------------

    cout << "Row-major time    : "
         << rowTime << " microseconds\n";

    cout << "Column-major time : "
         << columnTime << " microseconds\n";

    cout << "Column-major is   : "
         << ratio << "x slower than row-major\n";

    cout << "Sum: " << sum << endl;


    // -------------------------------
    // FREE MEMORY
    // -------------------------------

    for (int i = 0; i < N; i++) {
        delete[] a[i];
    }

    delete[] a;

    return 0;
}
